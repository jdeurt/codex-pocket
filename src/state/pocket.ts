import { type QueuedMessage } from "../lib/protocol";
import { type VoicePhase } from "./voice";

/** Resolve a scoped URL using an explicit Pocket identity.
@param pocketId - Selected conversation.
@param url - Endpoint that may already carry its scope.
@returns Endpoint for the selected Pocket.
*/
export function scopedPocketUrl(pocketId: string, url: string) {
  return pocketId === "main" || /[?&]pocket=/.test(url)
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}pocket=${encodeURIComponent(pocketId)}`;
}

/** Decide reload eligibility from a single explicit snapshot of durable-work status.
@param isSending - Whether a delivery is in progress.
@param voice - Media lifecycle.
@param queue - Outstanding message receipts.
@param isDraftSaved - Runtime-confirmed durable text status.
@param areAttachmentsSaved - Runtime-confirmed upload and persistence status.
@returns Whether reloading can preserve the user's work.
*/
export function canReloadPocket(
  isSending: boolean,
  voice: VoicePhase,
  queue: QueuedMessage[],
  isDraftSaved: boolean,
  areAttachmentsSaved: boolean
) {
  if (isSending || voice !== "idle" || !isDraftSaved || !areAttachmentsSaved) {
    return false;
  }

  for (const message of queue) {
    if (message.status === "unknown" || message.status === "sending") {
      return false;
    }
  }

  return true;
}
