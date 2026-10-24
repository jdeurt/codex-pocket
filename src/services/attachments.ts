import {
  attachmentState,
  attachmentSelectionError,
  patchedAttachment,
  removedAttachments,
  restoredAttachments,
} from "../state/attachments";
import { t } from "try";
import { type DraftAttachment, type SavedDraft } from "@/lib/draft-attachments";
import { observable } from "../runtime/stores";
import { SerialQueue } from "../runtime/serial-queue";
import { inactiveSubscription } from "../runtime/events";
import { savedDraft } from "../runtime/attachment-storage";
import { AttachmentUpload } from "./attachment-upload";

export type { DraftAttachment } from "@/lib/draft-attachments";

/**
Explicit runtime owner of file selection, persistence and upload cancellation.
*/
export class AttachmentController {
  private scope: string | undefined;
  private generation = 0;
  private readonly writes = new SerialQueue();
  private latestWrite: Promise<SavedDraft> | undefined;
  private readonly uploads = new Map<string, AttachmentUpload>();
  private readonly connections = new Map<string, () => () => void>();

  /** Restore only into the lifetime that initiated the read.
  @param parent - Conversation whose saved draft is being read.
  @param generation - Exact mounted lifetime.
  */
  private restore = async (parent: string, generation: number) => {
    const result = await t(savedDraft, parent);

    if (!this.isCurrent(generation)) {
      return;
    }

    this.store.setState(
      result.ok
        ? { draft: restoredAttachments(result.value), ready: true }
        : {
            error: result.error instanceof Error ? result.error.message : "Could not restore attachments.",
            ready: true,
          }
    );
  };

  /** Run one upload and always release its identity lock.
  @param entry - Original file and durable identity.
  */
  private upload = async (entry: DraftAttachment) => {
    if (this.uploads.has(entry.id)) {
      return;
    }

    const upload = new AttachmentUpload(this, entry, this.generation);

    this.uploads.set(entry.id, upload);
    const completed = await t(upload.run);

    if (this.uploads.get(entry.id) === upload) {
      this.uploads.delete(entry.id);
    }

    if (!completed.ok) {
      throw completed.error;
    }
  };

  /** Persist original bytes before starting any transfer.
  @param files - Accepted native file selection.
  */
  private append = async (files: File[]) => {
    const generation = this.generation;
    const added: DraftAttachment[] = [];
    const ids: string[] = [];

    for (const file of files) {
      const id = crypto.randomUUID();

      added.push({ id, file, progress: 0 });
      ids.push(id);
    }

    const draft = { files: [...this.store.getState().draft.files, ...added] };

    this.store.setState({ draft });
    const saved = await t(this.persist, draft);

    if (!this.isCurrent(generation)) {
      return;
    }

    if (!saved.ok) {
      this.store.setState({
        draft: removedAttachments(this.store.getState().draft, ids),
        error: saved.error instanceof Error ? saved.error.message : "Couldn't save these files. Try again.",
      });

      return;
    }

    const uploads: Promise<void>[] = Array.from(added, this.upload);

    await Promise.all(uploads);
  };

  readonly store = observable(attachmentState());
  readonly retry = this.upload;

  /** Persist one explicit draft through the serialized storage boundary.
  @param value - Original bytes and receipts to save.
  */
  persist = async (value: SavedDraft) => {
    const generation = this.generation;
    const pending = this.scope
      ? this.writes.run(savedDraft, this.scope, value)
      : Promise.reject(new Error("Wait for the conversation to connect."));

    this.store.setState({ isPersisted: false });
    this.latestWrite = pending;
    await pending;

    if (this.latestWrite === pending && this.isCurrent(generation)) {
      this.store.setState({ isPersisted: true });
    }
  };

  /** Begin a conversation-specific attachment lifetime.
  @param parent - Native conversation identity.
  @returns Cleanup bound to this exact generation.
  */
  connect = (parent: string) => {
    const generation = ++this.generation;

    this.scope = parent;
    this.store.setState({ ready: false, error: "", draft: { files: [] } });
    void this.restore(parent, generation);

    return this.disconnect.bind(this, generation);
  };

  /** Select a stable effect callback without opening browser resources during rendering.
  @param parent - Connected native conversation identity, if available.
  @returns Stable mounted-lifetime initializer for React.
  */
  connection = (parent?: string) => {
    if (!parent) {
      return inactiveSubscription;
    }

    const connect = this.connections.get(parent) ?? this.connect.bind(undefined, parent);

    this.connections.set(parent, connect);

    return connect;
  };

  /** Read persistence and upload status for navigation safeguards.
  @returns Whether reload can preserve selected files.
  */
  canReload = () => this.store.getState().isPersisted && this.uploads.size === 0;

  /** Validate selected files before performing persistence and upload effects.
  @param files - Native file picker selection.
  */
  add = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    const error = attachmentSelectionError(this.store.getState().draft.files, files);

    this.store.setState({ error });

    if (!error) {
      await this.append(files);
    }
  };

  /** Remove a selected file, abort its transfer and persist the remaining draft.
  @param id - Original attachment identity.
  */
  remove = async (id: string) => {
    const draft = removedAttachments(this.store.getState().draft, [id]);
    const generation = this.generation;

    this.uploads.get(id)?.controller.abort();
    this.uploads.delete(id);
    this.store.setState({ draft });
    const saved = await t(this.persist, draft);

    if (!saved.ok && this.isCurrent(generation)) {
      this.store.setState({
        error: saved.error instanceof Error ? saved.error.message : "Could not save attachments.",
      });
    }
  };

  /** Persist an idempotent send receipt before submitting attached files.
  @param id - Durable delivery identity.
  @param text - Original message text.
  */
  rememberSend = async (id: string, text: string) => {
    const draft = this.store.getState().draft;

    if (draft.files.length > 0) {
      await this.commit({ ...draft, pending: { id, text } });
    }
  };

  /**
  Clear durable files only after successful message delivery.
  */
  clear = async () => {
    if (this.store.getState().draft.files.length > 0) {
      await this.commit({ files: [] });
    }
  };

  /** Persist before publishing a complete draft replacement.
  @param draft - Replacement original files and receipt.
  */
  private async commit(draft: SavedDraft) {
    const generation = this.generation;

    await this.persist(draft);

    if (this.isCurrent(generation)) {
      this.store.setState({ draft });
    }
  }

  /** Reject late results and release this lifetime's transfers.
  @param generation - Exact mounted lifetime being released.
  */
  private disconnect(generation: number) {
    if (!this.isCurrent(generation)) {
      return;
    }

    this.generation++;
    this.scope = undefined;

    for (const upload of this.uploads.values()) {
      upload.controller.abort();
    }

    this.uploads.clear();
  }

  /** Read whether asynchronous work still belongs to the mounted conversation.
  @param generation - Lifetime that initiated the work.
  @returns Whether its result may be published.
  */
  isCurrent(generation: number) {
    return this.generation === generation && this.scope !== undefined;
  }

  /** Publish one immutable upload transition if its lifetime remains active.
  @param id - Original attachment identity.
  @param fields - Progress, receipt or failure updates.
  @param generation - Lifetime that owns the update.
  */
  patch(id: string, fields: Partial<DraftAttachment>, generation: number) {
    if (this.isCurrent(generation)) {
      this.store.setState({ draft: patchedAttachment(this.store.getState().draft, id, fields) });
    }
  }
}
