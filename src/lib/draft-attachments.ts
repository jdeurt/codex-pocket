import { type FileAttachment, fileAttachmentSchema } from "./attachments";
import { pocketUrl } from "@/lib/pockets";
import { z } from "zod";
import { t as attempt } from "try";

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
const storedFileSchema = z.object({ name: z.string(), type: z.string(), bytes: z.instanceof(ArrayBuffer) });
const storedAttachmentSchema = z.object({
  id: z.string(),
  progress: z.number(),
  error: z.string().optional(),
  uploaded: fileAttachmentSchema.optional(),
  file: storedFileSchema,
});
const storedDraftSchema = z.object({
  files: z.array(storedAttachmentSchema),
  pending: z.object({ id: z.string(), text: z.string() }).optional(),
});

type StoredDraft = z.infer<typeof storedDraftSchema>;
const uploadResponseSchema = z.object({ file: fileAttachmentSchema.optional(), error: z.string().optional() });

/**
Open the per-device attachment store, creating its draft object store when needed.
@returns The database handle, which the caller must close after its transaction.
*/
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

/**
Serialize one attachment without depending on browser persistence of File objects.
@param entry - Draft file whose original bytes and metadata must survive interruption.
@returns The stored attachment with its complete original byte buffer.
*/
async function storedAttachment(entry: DraftAttachment): Promise<StoredDraft["files"][number]> {
  return {
    ...entry,
    file: { name: entry.file.name, type: entry.file.type, bytes: await entry.file.arrayBuffer() },
  };
}

/**
Prepare a write payload while allowing the same transaction path to read without a payload.
@param value - Draft to write, or undefined for a read.
@returns The byte-preserving stored draft, or undefined when reading.
*/
async function storedDraft(value: SavedDraft | undefined) {
  return value && { ...value, files: await Promise.all(value.files.map((entry) => storedAttachment(entry))) };
}

/** Read or write a prepared draft in one native IndexedDB transaction.
@param db - Open database owned by the caller.
@param parent - Conversation namespace.
@param stored - Serialized draft for writes, or undefined for reads.
@returns Validated stored bytes after the transaction completes.
*/
function draftTransaction(db: IDBDatabase, parent: string, stored?: StoredDraft) {
  return new Promise<StoredDraft>((resolve, reject) => {
    const transaction = db.transaction("drafts", stored ? "readwrite" : "readonly");
    const store = transaction.objectStore("drafts");
    const request = stored ? store.put(stored, parent) : store.get(parent);
    const failed = () => {
      reject(new Error("Couldn't save files on this device. Free up browser storage and try again."));
    };

    transaction.oncomplete = () => {
      const result = storedDraftSchema.safeParse(stored ?? request.result ?? { files: [] });

      if (result.success) {
        resolve(result.data);
      } else {
        reject(new Error("Saved attachments could not be read.", { cause: result.error }));
      }
    };
    transaction.addEventListener("error", failed);
    transaction.addEventListener("abort", failed);
  });
}

/** Serialize before opening storage, then close the database after the owned transaction.
@param parent - Conversation namespace.
@param value - Draft to write, or undefined to restore.
@returns Draft reconstructed with original file bytes.
*/
export async function savedDraft(parent: string, value?: SavedDraft): Promise<SavedDraft> {
  // ArrayBuffers also work in Safari sessions that cannot persist File/Blob objects.
  const stored = await storedDraft(value);
  const db = await database();

  return draftTransaction(db, parent, stored)
    .then((result) => ({
      ...result,
      files: result.files.map((entry) => ({
        ...entry,
        file: new File([entry.file.bytes], entry.file.name, { type: entry.file.type }),
      })),
    }))
    .finally(() => {
      db.close();
    });
}

/**
Upload original file bytes with progress and cancellation, validating the server receipt.
@param entry - Draft attachment whose durable ID and original bytes are transported.
@param progress - Receives percentages below 100 until a validated response completes.
@param signal - Caller-owned cancellation signal for the upload.
@returns The server's normalized attachment metadata.
*/
export function uploadFile(entry: DraftAttachment, progress: (value: number) => void, signal: AbortSignal) {
  return new Promise<FileAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/uploads?${new URLSearchParams({ id: entry.id, name: entry.file.name, type: entry.file.type || "application/octet-stream" })}`;

    xhr.open("PUT", pocketUrl(url));
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
      const parsed = attempt(() => uploadResponseSchema.parse(JSON.parse(xhr.responseText)));

      if (!parsed.ok) {
        const error = parsed.error;

        reject(new Error("Upload failed. Retry when connected.", { cause: error }));

        return;
      }

      const result = parsed.value;

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
