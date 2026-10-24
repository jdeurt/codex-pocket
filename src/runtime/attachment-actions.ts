import { type DraftAttachment } from "../lib/draft-attachments";

/** Retry from a native control while the attachment service owns errors and progress.
@param retry - Owning upload operation.
@param entry - Failed draft attachment.
*/
export function retryAttachment(retry: (entry: DraftAttachment) => Promise<void>, entry: DraftAttachment) {
  void retry(entry);
}

/** Remove from a native control while the attachment service owns persistence and errors.
@param remove - Owning removal operation.
@param id - Draft identity.
*/
export function removeAttachment(remove: (id: string) => Promise<void>, id: string) {
  void remove(id);
}
