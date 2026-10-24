import { type Turn, hasHistory } from "../lib/protocol";
import { type Receipt } from "./outbox";

const RECOVERY_ID_PREFIX = "pocket-recovery:";
export const RECOVERY_PROMPT = `Pocket has restarted this Codex process and resumed your existing conversation. Review the conversation and continue any unfinished or in-progress work, respecting the latest operator instructions. Inspect whether any subagents or delegated jobs that are expected to remain active are running as intended; reconnect, resume or report problems where appropriate. Do not blindly duplicate jobs or start new delegation merely because of this restart. If no authorized work or expected jobs remain open and there is no meaningful issue to report, end silently. Respond normally; no special completion marker is needed.`;

/**
Recognize reserved restart-recovery identities without matching user text.
@param id - Untrusted native or receipt message identity.
@returns Whether this identity uses the recovery prefix.
*/
export function isRecoveryMessageId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(RECOVERY_ID_PREFIX);
}

/**
Create recovery work only for hydrated history without an outstanding recovery receipt.
@param turns - Existing hydrated conversation history.
@param receipts - Current persisted delivery receipts.
@param id - Runtime-generated recovery identity.
@returns Fresh queued recovery receipt, or undefined when unnecessary.
*/
export function recoveryReceipt(turns: Turn[], receipts: Receipt[], id: string): Receipt | undefined {
  if (!hasHistory(turns)) {
    return;
  }

  for (const receipt of receipts) {
    if (isRecoveryMessageId(receipt.id) && receipt.status !== "sent") {
      return;
    }
  }

  return { id: `${RECOVERY_ID_PREFIX}${id}`, text: RECOVERY_PROMPT, status: "queued" };
}
