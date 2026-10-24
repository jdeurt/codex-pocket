import { findById, upsertById } from "../lib/identity";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES } from "../lib/attachments";
import { type SavedDraft, type DraftAttachment } from "../lib/draft-attachments";

export interface AttachmentState {
  draft: SavedDraft;
  ready: boolean;
  error: string;
  isPersisted: boolean;
}

/** Create attachment state without reading persisted files.
@returns Empty attachment projection, awaiting runtime hydration.
*/
export function attachmentState(): AttachmentState {
  return { draft: { files: [] }, ready: false, error: "", isPersisted: true };
}

/** Mark an unfinished upload as retryable while preserving completed receipts.
@param file - Original file and persisted upload metadata.
@returns Restored attachment projection.
*/
function restoredAttachment(file: SavedDraft["files"][number]) {
  return file.uploaded ? file : { ...file, error: "Upload interrupted. Retry to continue." };
}

/** Restore interrupted uploads without modifying durable receipts or original file bytes.
@param value - Saved attachment draft.
@returns Restored files with actionable errors for unfinished uploads.
*/
export function restoredAttachments(value: SavedDraft): SavedDraft {
  return { ...value, files: Array.from(value.files, restoredAttachment) };
}

/** Apply progress or an upload receipt to one explicitly identified attachment.
@param draft - Current draft, left unchanged.
@param id - Attachment identity.
@param fields - Updated upload projection.
@returns Next attachment draft.
*/
export function patchedAttachment(
  draft: SavedDraft,
  id: string,
  fields: Partial<SavedDraft["files"][number]>
): SavedDraft {
  const file = findById(draft.files, id);

  return file ? { ...draft, files: upsertById(draft.files, { ...file, ...fields }) } : draft;
}

/** Remove user-selected files and invalidate any previous pending send identity.
@param draft - Current attachment draft.
@param ids - Explicit identities to remove.
@returns Remaining files in their existing order.
*/
export function removedAttachments(draft: SavedDraft, ids: readonly string[]): SavedDraft {
  const removed = new Set(ids);
  const files: SavedDraft["files"] = [];

  for (const file of draft.files) {
    if (!removed.has(file.id)) {
      files.push(file);
    }
  }

  return { files };
}

/** Validate attachment selection using explicit file metadata only.
@param existing - Current draft files.
@param selected - Newly selected files.
@returns Actionable validation failure, or empty text for an accepted selection.
*/
export function attachmentSelectionError(existing: SavedDraft["files"], selected: readonly File[]) {
  if (existing.length + selected.length > MAX_ATTACHMENTS) {
    return "Attach up to 10 files at a time.";
  }

  let bytes = 0;

  for (const file of selected) {
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      return "Choose nonempty files up to 25 MB each.";
    }

    bytes += file.size;
  }

  for (const entry of existing) {
    bytes += entry.file.size;
  }

  return bytes > MAX_ATTACHMENT_BYTES ? "Attachments must total 50 MB or less." : "";
}

/** Check whether a draft file has a validated upload receipt.
@param file - Current draft attachment.
@returns Whether the attachment can be submitted.
*/
export function hasUploadedAttachment(file: DraftAttachment) {
  return !!file.uploaded;
}
