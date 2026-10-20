"use client";
import { type DraftAttachment, type SavedDraft, savedDraft, uploadFile } from "@/lib/draft-attachments";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES } from "@/lib/attachments";
import { useEffect, useRef, useState } from "react";

export type { DraftAttachment } from "@/lib/draft-attachments";
const PERCENT = 100;
const empty: SavedDraft = { files: [] };

/**
Serialize draft writes while allowing a failed previous write to be retried.
@param previous - Completion of the last queued write, whose result is intentionally unused.
@param parent - Parent conversation that owns the new write.
@param value - Exact draft and original file bytes to persist.
*/
async function persistDraftAfter(previous: Promise<void>, parent: string, value: SavedDraft) {
  try {
    await previous;
  } catch {
    /*
    A failed write must not block a later retry.
    */
  }

  await savedDraft(parent, value);
}

/**
Restore one parent's draft while retaining ownership of late results and active uploads.
@param parent - Conversation whose saved draft is being read.
@param uploads - Existing controller map whose uploads must stop when this view leaves.
@param restored - Receives a validated draft only while this subscription is active.
@param failed - Receives a storage failure only while this subscription is active.
@returns Cleanup that rejects late results and aborts this view's outstanding uploads.
*/
function restoreDraft(
  parent: string,
  uploads: Map<string, AbortController>,
  restored: (value: SavedDraft) => void,
  failed: (error: unknown) => void
) {
  let isActive = true;

  void savedDraft(parent)
    .then((value) => {
      if (isActive) {
        restored(value);
      }
    })
    .catch((error: unknown) => {
      if (isActive) {
        failed(error);
      }
    });

  return () => {
    isActive = false;

    for (const controller of uploads.values()) {
      controller.abort();
    }

    uploads.clear();
  };
}

/**
Restore and persist one parent draft while owning its original-byte uploads and cancellation.
@param [parent] - Parent conversation ID, absent while the conversation is unconfigured.
@returns Draft state, readiness/errors and the existing upload, retry, removal and send-persistence operations.
*/
export function useAttachments(parent?: string) {
  const [state, setState] = useState<SavedDraft>(empty);
  const [loadedParent, setLoadedParent] = useState<string>();
  const [error, setError] = useState("");
  const current = useRef<SavedDraft>(empty);
  const scope = useRef<string | undefined>(undefined);
  const uploads = useRef(new Map<string, AbortController>());
  const writes = useRef<Promise<void>>(Promise.resolve());
  const isPersisted = useRef(true);

  function update(value: SavedDraft) {
    current.current = value;
    setState(value);
  }

  function persist(value: SavedDraft) {
    const owner = scope.current;
    const pending = owner
      ? persistDraftAfter(writes.current, owner, value)
      : Promise.reject(new Error("Wait for the conversation to connect."));

    isPersisted.current = false;

    writes.current = pending;
    void pending
      .then(() => {
        if (writes.current === pending) {
          isPersisted.current = true;
        }
      })
      .catch(() => {
        // Keep automatic refresh blocked while the only copy is in memory.
      });

    return writes.current;
  }

  useEffect(() => {
    if (!parent) {
      return;
    }

    scope.current = parent;

    return restoreDraft(
      parent,
      uploads.current,
      (value) => {
        update({
          ...value,
          files: value.files.map((file) =>
            file.uploaded ? file : { ...file, error: "Upload interrupted. Retry to continue." }
          ),
        });
        setLoadedParent(parent);
      },
      (error_) => {
        setError(error_ instanceof Error ? error_.message : "Could not restore attachments.");
        setLoadedParent(parent);
      }
    );
  }, [parent]);

  async function performUpload(entry: DraftAttachment) {
    const controller = new AbortController();
    const owner = scope.current;

    uploads.current.set(entry.id, controller);

    function patch(fields: Partial<DraftAttachment>) {
      if (scope.current !== owner) {
        return;
      }

      update({
        ...current.current,
        files: current.current.files.map((file) => (file.id === entry.id ? { ...file, ...fields } : file)),
      });
    }

    patch({ progress: 0, error: undefined });

    try {
      const uploaded = await uploadFile(
        entry,
        (progress) => {
          patch({ progress });
        },
        controller.signal
      );

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
          setError(error__ instanceof Error ? error__.message : "Could not save attachments.");
        }
      }
    } finally {
      uploads.current.delete(entry.id);
    }
  }

  async function upload(entry: DraftAttachment) {
    if (uploads.current.has(entry.id)) {
      return;
    }

    await performUpload(entry);
  }

  async function appendSelectedFiles(files: File[]) {
    const existing = current.current.files;
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

  async function add(files: File[]) {
    if (files.length === 0) {
      return;
    }

    setError("");

    if (current.current.files.length + files.length > MAX_ATTACHMENTS) {
      setError("Attach up to 10 files at a time.");

      return;
    }

    if (files.some((file) => file.size === 0 || file.size > MAX_FILE_BYTES)) {
      setError("Choose nonempty files up to 25 MB each.");

      return;
    }

    if (
      [...current.current.files.map((entry) => entry.file), ...files].reduce((total, file) => total + file.size, 0) >
      MAX_ATTACHMENT_BYTES
    ) {
      setError("Attachments must total 50 MB or less.");

      return;
    }

    await appendSelectedFiles(files);
  }

  async function remove(id: string) {
    const value = { files: current.current.files.filter((file) => file.id !== id) };

    uploads.current.get(id)?.abort();
    uploads.current.delete(id);

    update(value);

    try {
      await persist(value);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : "Could not save attachments.");
    }
  }

  async function commitDraft(value: SavedDraft) {
    await persist(value);
    update(value);
  }

  async function rememberSend(id: string, text: string) {
    if (current.current.files.length === 0) {
      return;
    }

    await commitDraft({ ...current.current, pending: { id, text } });
  }

  async function clear() {
    if (current.current.files.length === 0) {
      return;
    }

    await commitDraft(empty);
  }

  return {
    ...state,
    canReload: () => isPersisted.current && uploads.current.size === 0,
    ready: loadedParent === parent && !!parent,
    error,
    add,
    remove,
    retry: upload,
    rememberSend,
    clear,
  };
}
