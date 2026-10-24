import { t } from "try";
import { type DraftAttachment } from "../lib/draft-attachments";
import { uploadFile } from "../runtime/file-upload";
import { type AttachmentController } from "./attachments";

const PERCENT = 100;

/**
Runtime owner of one original-byte upload and its progress callbacks.
*/
export class AttachmentUpload {
  /** Publish progress only to the lifetime that initiated this upload.
  @param fields - Updated upload status.
  */
  private patch = (fields: Partial<DraftAttachment>) => {
    this.owner.patch(this.entry.id, fields, this.generation);
  };

  /** Receive a native progress notification.
  @param progress - Upload percentage.
  */
  private progress = (progress: number) => {
    this.patch({ progress });
  };

  /**
  Transfer original bytes, then persist the accepted receipt.
  */
  private transfer = async () => {
    this.patch({ progress: 0, error: undefined });
    const uploaded = await uploadFile(this.entry, this.progress, this.controller.signal);

    if (!this.owner.isCurrent(this.generation)) {
      return;
    }

    this.patch({ uploaded, progress: PERCENT });
    await this.owner.persist(this.owner.store.getState().draft);
  };

  /** Retain failed original bytes for a user-initiated retry.
  @param error - Transfer or persistence failure.
  */
  private recover = async (error: unknown) => {
    if (this.controller.signal.aborted || !this.owner.isCurrent(this.generation)) {
      return;
    }

    this.patch({
      uploaded: undefined,
      error: error instanceof Error ? error.message : "Upload failed. Retry to continue.",
    });
    const saved = await t(this.owner.persist, this.owner.store.getState().draft);

    if (!saved.ok && this.owner.isCurrent(this.generation)) {
      this.owner.store.setState({
        error: saved.error instanceof Error ? saved.error.message : "Could not save attachments.",
      });
    }
  };

  readonly controller = new AbortController();

  /**
  Transfer and recover while preserving abort semantics.
  */
  run = async () => {
    const sent = await t(this.transfer);

    if (!sent.ok) {
      await this.recover(sent.error);
    }
  };

  /** Bind this upload to its exact original file and mounted owner.
  @param owner - Explicit attachment runtime.
  @param entry - Original file and durable identity.
  @param generation - Mounted lifetime that initiated the transfer.
  */
  constructor(
    private readonly owner: AttachmentController,
    private readonly entry: DraftAttachment,
    private readonly generation: number
  ) {}
}
