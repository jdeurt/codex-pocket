import { type FileAttachment, fileAttachmentSchema } from "./attachments";
import { z } from "zod";

const UPLOAD_TIMEOUT_MS = 180_000;
const PERCENT = 100;
const UPLOADING_MAX_PERCENT = 99;
const HTTP_OK = 200;
const HTTP_REDIRECT = 300;

export interface DraftAttachment {
  id: string;
  file: File;
  uploaded?: FileAttachment;
  progress: number;
  error?: string;
}
export interface SavedDraft {
  files: DraftAttachment[];
  pending?: { id: string; text: string };
}
const storedDraftSchema = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      progress: z.number(),
      error: z.string().optional(),
      uploaded: fileAttachmentSchema.optional(),
      file: z.object({ name: z.string(), type: z.string(), bytes: z.instanceof(ArrayBuffer) }),
    })
  ),
  pending: z.object({ id: z.string(), text: z.string() }).optional(),
});
type StoredDraft = z.infer<typeof storedDraftSchema>;
const uploadResponseSchema = z.object({ file: fileAttachmentSchema.optional(), error: z.string().optional() });

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("pocket-attachments", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.addEventListener("error", () => {
      reject(new Error("Couldn't save files on this device. Allow browser storage and try again."));
    });
  });
}

export async function savedDraft(parent: string, value?: SavedDraft): Promise<SavedDraft> {
  const db = await database();

  try {
    // ArrayBuffers also work in Safari sessions that cannot persist File/Blob objects.
    const stored = value && {
      ...value,
      files: await Promise.all(
        value.files.map(async (entry) => ({
          ...entry,
          file: { name: entry.file.name, type: entry.file.type, bytes: await entry.file.arrayBuffer() },
        }))
      ),
    };
    const result = await new Promise<StoredDraft>((resolve, reject) => {
      const transaction = db.transaction("drafts", value ? "readwrite" : "readonly");
      const store = transaction.objectStore("drafts");
      const request = stored ? store.put(stored, parent) : store.get(parent);
      transaction.oncomplete = () => {
        try {
          const data: unknown = request.result;
          resolve(storedDraftSchema.parse(stored ?? data ?? { files: [] }));
        } catch (error) {
          reject(new Error("Saved attachments could not be read.", { cause: error }));
        }
      };
      const failed = () => {
        reject(new Error("Couldn't save files on this device. Free up browser storage and try again."));
      };
      transaction.addEventListener("error", failed);
      transaction.addEventListener("abort", failed);
    });

    return {
      ...result,
      files: result.files.map((entry) => ({
        ...entry,
        file: new File([entry.file.bytes], entry.file.name, { type: entry.file.type }),
      })),
    };
  } finally {
    db.close();
  }
}

export function uploadFile(entry: DraftAttachment, progress: (value: number) => void, signal: AbortSignal) {
  return new Promise<FileAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/uploads?${new URLSearchParams({ id: entry.id, name: entry.file.name, type: entry.file.type || "application/octet-stream" })}`;
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.addEventListener("progress", (event) => {
      progress(
        event.lengthComputable ? Math.min(UPLOADING_MAX_PERCENT, Math.round((event.loaded * PERCENT) / event.total)) : 0
      );
    });
    xhr.addEventListener("error", () => {
      reject(new Error("Upload interrupted. Retry when connected."));
    });
    xhr.ontimeout = () => {
      reject(new Error("Upload timed out. Retry when connected."));
    };
    xhr.addEventListener("abort", () => {
      reject(new Error("Upload interrupted. Retry when connected."));
    });
    xhr.addEventListener("load", () => {
      let result: z.infer<typeof uploadResponseSchema>;

      try {
        result = uploadResponseSchema.parse(JSON.parse(xhr.responseText));
      } catch (error) {
        reject(new Error("Upload failed. Retry when connected.", { cause: error }));

        return;
      }

      if (xhr.status < HTTP_OK || xhr.status >= HTTP_REDIRECT || !result.file) {
        reject(new Error(result.error?.length ? result.error : "Upload failed. Retry or choose another file."));

        return;
      }

      resolve(result.file);
    });
    signal.addEventListener(
      "abort",
      () => {
        xhr.abort();
      },
      { once: true }
    );
    xhr.send(entry.file);
  });
}
