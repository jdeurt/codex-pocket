import type { Snapshot, Turn } from "../lib/protocol";
import type { Receipt } from "./outbox";
import { log } from "./logging";

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
@returns Fresh queued recovery receipt, or undefined when unnecessary.
*/
export function recoveryReceipt(turns: Turn[], receipts: Receipt[]): Receipt | undefined {
  const hasHistory = turns.some((turn) => turn.items.length > 0);
  const isPending = receipts.some((receipt) => isRecoveryMessageId(receipt.id) && receipt.status !== "sent");

  return hasHistory && !isPending
    ? { id: `${RECOVERY_ID_PREFIX}${crypto.randomUUID()}`, text: RECOVERY_PROMPT, status: "queued" }
    : undefined;
}

/**
Append and log required recovery work without duplicating a pending recovery.
@param state - Current hydrated parent snapshot.
@param receipts - Mutable delivery queue receiving the recovery receipt.
@returns Whether a recovery receipt was appended.
*/
export function isQueueRecovery(state: Snapshot, receipts: Receipt[]) {
  const recovery = recoveryReceipt(state.turns, receipts);

  if (!recovery) {
    return false;
  }

  receipts.push(recovery);
  log().info({ id: recovery.id, threadId: state.threadId }, "recovery.queued");

  return true;
}
