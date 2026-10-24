import { type DraftAttachment, type SavedDraft, savedDraft, uploadFile } from "@/lib/draft-attachments";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES } from "@/lib/attachments";
import { createAttachmentStore } from "../state/attachments";

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
  await previous.catch(() => {
    /*
    A failed write must not block a later retry.
    */
  });

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
@returns Draft state, readiness/errors and the existing upload, retry, removal and send-persistence operations.
*/
export function createAttachmentController() {
  const store = createAttachmentStore();
  const uploads = new Map<string, AbortController>();

  let scope: string | undefined;
  let writes: Promise<void> = Promise.resolve();

  const setError = (error: string) => {
    store.setState({ error });
  };

  function update(value: SavedDraft) {
    store.setState({ draft: value });
  }

  function persist(value: SavedDraft) {
    const owner = scope;
    const pending = owner
      ? persistDraftAfter(writes, owner, value)
      : Promise.reject(new Error("Wait for the conversation to connect."));

    store.setState({ isPersisted: false });

    writes = pending;
    void pending
      .then(() => {
        if (writes === pending) {
          store.setState({ isPersisted: true });
        }
      })
      .catch(() => {
        // Keep automatic refresh blocked while the only copy is in memory.
      });

    return writes;
  }

  function connect(parent: string) {
    scope = parent;
    store.setState({ ready: false, error: "", draft: empty });

    return restoreDraft(
      parent,
      uploads,
      (value) => {
        update({
          ...value,
          files: value.files.map((file) =>
            file.uploaded ? file : { ...file, error: "Upload interrupted. Retry to continue." }
          ),
        });
        store.setState({ ready: true });
      },
      (error) => {
        setError(error instanceof Error ? error.message : "Could not restore attachments.");
        store.setState({ ready: true });
      }
    );
  }

  async function performUpload(entry: DraftAttachment) {
    const controller = new AbortController();
    const owner = scope;

    uploads.set(entry.id, controller);

    function patch(fields: Partial<DraftAttachment>) {
      if (scope !== owner) {
        return;
      }

      update({
        ...store.getState().draft,
        files: store.getState().draft.files.map((file) => (file.id === entry.id ? { ...file, ...fields } : file)),
      });
    }

    patch({ progress: 0, error: undefined });

    await (async () => {
      const uploaded = await uploadFile(
        entry,
        (progress) => {
          patch({ progress });
        },
        controller.signal
      );

      patch({ uploaded, progress: PERCENT });
      await persist(store.getState().draft);
    })()
      .catch(async (error_: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        patch({
          uploaded: undefined,
          error: error_ instanceof Error ? error_.message : "Upload failed. Retry to continue.",
        });

        await (async () => persist(store.getState().draft))().catch((error__: unknown) => {
          setError(error__ instanceof Error ? error__.message : "Could not save attachments.");
        });
      })
      .finally(() => {
        uploads.delete(entry.id);
      });
  }

  async function upload(entry: DraftAttachment) {
    if (uploads.has(entry.id)) {
      return;
    }

    await performUpload(entry);
  }

  async function appendSelectedFiles(files: File[]) {
    const existing = store.getState().draft.files;
    const added = files.map((file) => ({ id: crypto.randomUUID(), file, progress: 0 }));
    const value = { files: [...existing, ...added] };

    update(value);

    await (async () => {
      // Persist file bytes before starting the request, so interruption never loses the selection.
      await persist(value);
      await Promise.all(added.map((entry) => upload(entry)));
    })().catch((error_: unknown) => {
      update({ files: store.getState().draft.files.filter((file) => added.every((entry) => entry.id !== file.id)) });
      setError(error_ instanceof Error ? error_.message : "Couldn't save these files. Try again.");
    });
  }

  async function add(files: File[]) {
    if (files.length === 0) {
      return;
    }

    setError("");

    if (store.getState().draft.files.length + files.length > MAX_ATTACHMENTS) {
      setError("Attach up to 10 files at a time.");

      return;
    }

    if (files.some((file) => file.size === 0 || file.size > MAX_FILE_BYTES)) {
      setError("Choose nonempty files up to 25 MB each.");

      return;
    }

    if (
      [...store.getState().draft.files.map((entry) => entry.file), ...files].reduce(
        (total, file) => total + file.size,
        0
      ) > MAX_ATTACHMENT_BYTES
    ) {
      setError("Attachments must total 50 MB or less.");

      return;
    }

    await appendSelectedFiles(files);
  }

  async function remove(id: string) {
    const value = { files: store.getState().draft.files.filter((file) => file.id !== id) };

    uploads.get(id)?.abort();
    uploads.delete(id);

    update(value);

    await (async () => persist(value))().catch((error_: unknown) => {
      setError(error_ instanceof Error ? error_.message : "Could not save attachments.");
    });
  }

  async function commitDraft(value: SavedDraft) {
    await persist(value);
    update(value);
  }

  async function rememberSend(id: string, text: string) {
    if (store.getState().draft.files.length === 0) {
      return;
    }

    await commitDraft({ ...store.getState().draft, pending: { id, text } });
  }

  async function clear() {
    if (store.getState().draft.files.length === 0) {
      return;
    }

    await commitDraft(empty);
  }

  return {
    store,
    connect,
    canReload: () => store.getState().isPersisted && uploads.size === 0,
    add,
    remove,
    retry: upload,
    rememberSend,
    clear,
  };
}
