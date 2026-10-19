"use client";
import { type FileAttachment, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES } from "@/lib/attachments";
import { useEffect, useRef, useState } from "react";

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
interface SavedDraft {
  files: DraftAttachment[];
  pending?: { id: string; text: string };
}
interface StoredDraft {
  files: (Omit<DraftAttachment, "file"> & { file: { name: string; type: string; bytes: ArrayBuffer } })[];
  pending?: SavedDraft["pending"];
}
const empty: SavedDraft = { files: [] };

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("pocket-attachments", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.addEventListener("error", () =>
      reject(new Error("Couldn't save files on this device. Allow browser storage and try again."))
    );
  });
}

async function savedDraft(parent: string, value?: SavedDraft): Promise<SavedDraft> {
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
      transaction.oncomplete = () => resolve(stored ?? (request.result as StoredDraft | undefined) ?? { files: [] });
      const failed = () =>
        reject(new Error("Couldn't save files on this device. Free up browser storage and try again."));
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

function uploadFile(entry: DraftAttachment, progress: (value: number) => void, signal: AbortSignal) {
  return new Promise<FileAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/uploads?${new URLSearchParams({ id: entry.id, name: entry.file.name, type: entry.file.type || "application/octet-stream" })}`;
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.addEventListener("progress", (event) =>
      progress(
        event.lengthComputable ? Math.min(UPLOADING_MAX_PERCENT, Math.round((event.loaded * PERCENT) / event.total)) : 0
      )
    );
    xhr.addEventListener("error", () => reject(new Error("Upload interrupted. Retry when connected.")));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Retry when connected."));
    xhr.addEventListener("abort", () => reject(new Error("Upload interrupted. Retry when connected.")));
    xhr.addEventListener("load", () => {
      try {
        const result = JSON.parse(xhr.responseText) as { file?: FileAttachment; error?: string };

        if (xhr.status < HTTP_OK || xhr.status >= HTTP_REDIRECT || !result.file) {
          throw new Error(result.error || "Upload failed. Retry or choose another file.");
        }

        resolve(result.file);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Upload failed. Retry when connected."));
      }
    });
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(entry.file);
  });
}

export function useAttachments(parent?: string) {
  const [state, setState] = useState<SavedDraft>(empty);
  const [loadedParent, setLoadedParent] = useState<string>();
  const [error, setError] = useState("");
  const current = useRef<SavedDraft>(empty);
  const scope = useRef<string | undefined>(undefined);
  const uploads = useRef(new Map<string, AbortController>());
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  function update(value: SavedDraft) {
    current.current = value;
    setState(value);
  }

  function persist(value: SavedDraft) {
    const owner = scope.current;

    if (!owner) {
      return Promise.reject(new Error("Wait for the conversation to connect."));
    }

    const previous = writes.current;
    const result = (async () => {
      try {
        await previous;
      } catch {
        /*
        A failed write must not block a later retry.
        */
      }

      return savedDraft(owner, value);
    })();
    writes.current = result;

    return result;
  }

  useEffect(() => {
    if (!parent) {
      return;
    }

    scope.current = parent;
    let active = true;
    void savedDraft(parent)
      .then((value) => {
        if (!active) {
          return;
        }

        update({
          ...value,
          files: value.files.map((file) =>
            file.uploaded ? file : { ...file, error: "Upload interrupted. Retry to continue." }
          ),
        });
        setLoadedParent(parent);
      })
      .catch((error_: Error) => {
        if (!active) {
          return;
        }

        setError(error_.message);
        setLoadedParent(parent);
      });
    const activeUploads = uploads.current;

    return () => {
      active = false;

      for (const controller of activeUploads.values()) {
        controller.abort();
      }

      activeUploads.clear();
    };
  }, [parent]);

  async function upload(entry: DraftAttachment) {
    if (uploads.current.has(entry.id)) {
      return;
    }

    const controller = new AbortController();
    const owner = scope.current;
    uploads.current.set(entry.id, controller);
    const patch = (fields: Partial<DraftAttachment>) => {
      if (scope.current !== owner) {
        return;
      }

      update({
        ...current.current,
        files: current.current.files.map((file) => (file.id === entry.id ? { ...file, ...fields } : file)),
      });
    };
    patch({ progress: 0, error: undefined });

    try {
      const uploaded = await uploadFile(entry, (progress) => patch({ progress }), controller.signal);
      patch({ uploaded, progress: PERCENT });
      await persist(current.current);
    } catch (error_) {
      if (!controller.signal.aborted) {
        patch({
          uploaded: undefined,
          error: error_ instanceof Error ? error_.message : "Upload failed. Retry to continue.",
        });

        try {
          await persist(current.current);
        } catch (error__) {
          setError((error__ as Error).message);
        }
      }
    } finally {
      uploads.current.delete(entry.id);
    }
  }

  async function add(files: File[]) {
    if (files.length === 0) {
      return;
    }

    setError("");
    const existing = current.current.files;

    if (existing.length + files.length > MAX_ATTACHMENTS) {
      setError("Attach up to 10 files at a time.");

      return;
    }

    if (files.some((file) => file.size === 0 || file.size > MAX_FILE_BYTES)) {
      setError("Choose nonempty files up to 25 MB each.");

      return;
    }

    if (
      [...existing.map((entry) => entry.file), ...files].reduce((total, file) => total + file.size, 0) >
      MAX_ATTACHMENT_BYTES
    ) {
      setError("Attachments must total 50 MB or less.");

      return;
    }

    const added = files.map((file) => ({ id: crypto.randomUUID(), file, progress: 0 }));
    const value = { files: [...existing, ...added] };
    update(value);

    try {
      // Persist file bytes before starting the request, so interruption never loses the selection.
      await persist(value);
      await Promise.all(added.map((entry) => upload(entry)));
    } catch (error_) {
      update({ files: current.current.files.filter((file) => added.every((entry) => entry.id !== file.id)) });
      setError(error_ instanceof Error ? error_.message : "Couldn't save these files. Try again.");
    }
  }

  async function remove(id: string) {
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
    const value = { files: current.current.files.filter((file) => file.id !== id) };
    update(value);

    try {
      await persist(value);
    } catch (error_) {
      setError((error_ as Error).message);
    }
  }

  async function rememberSend(id: string, text: string) {
    if (current.current.files.length === 0) {
      return;
    }

    const value = { ...current.current, pending: { id, text } };
    await persist(value);
    update(value);
  }

  async function clear() {
    if (current.current.files.length === 0) {
      return;
    }

    await persist(empty);
    update(empty);
  }

  return {
    ...state,
    ready: loadedParent === parent && !!parent,
    error,
    add,
    remove,
    retry: upload,
    rememberSend,
    clear,
  };
}
