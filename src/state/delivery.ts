import { type ThreadState } from "./thread";
import { type AttachmentState } from "./attachments";
import { type VoicePhase } from "./voice";
import { type FileAttachment } from "../lib/attachments";

export interface MessageInput {
  text: string;
  attachments: FileAttachment[];
  receiptId?: string;
}

/** Decide whether a send is valid using one explicit snapshot of its dependencies.
@param thread - Conversation projection.
@param voice - Current media lifecycle.
@param files - Original-file and upload projection.
@param draft - Current user-entered text.
@param isBusy - Whether another send owns the operation.
@returns Prepared input or no work when sending is unavailable.
*/
export function messageInput(
  thread: ThreadState,
  voice: VoicePhase,
  files: AttachmentState,
  draft: string,
  isBusy: boolean
): MessageInput | undefined {
  const text = draft.trim();

  if (
    isBusy ||
    voice !== "idle" ||
    !thread.connected ||
    thread.state.connection !== "connected" ||
    !files.ready ||
    (!text && files.draft.files.length === 0)
  ) {
    return;
  }

  const attachments: FileAttachment[] = [];

  for (const entry of files.draft.files) {
    if (!entry.uploaded) {
      return;
    }

    attachments.push(entry.uploaded);
  }

  return { text, attachments, receiptId: files.draft.pending?.text === text ? files.draft.pending.id : undefined };
}

/** Select an explicit upload receipt's durable identity.
@param file - Original upload receipt.
@returns Stable attachment identity.
*/
export function attachmentId(file: FileAttachment) {
  return file.id;
}
