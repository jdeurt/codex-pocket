import type { Snapshot, Turn } from "../lib/protocol";
import type { Receipt } from "./outbox";
import { log } from "./logging";

const RECOVERY_ID_PREFIX = "pocket-recovery:";
export const RECOVERY_PROMPT = `Pocket has restarted this Codex process and resumed your existing conversation. Review the conversation and continue any unfinished or in-progress work, respecting the latest operator instructions. Inspect whether any subagents or delegated jobs that are expected to remain active are running as intended; reconnect, resume or report problems where appropriate. Do not blindly duplicate jobs or start new delegation merely because of this restart. If no work or expected jobs remain open, say so briefly. Respond normally; no special completion marker is needed.`;

export function isRecoveryMessageId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(RECOVERY_ID_PREFIX);
}

export function recoveryReceipt(turns: Turn[], receipts: Receipt[]): Receipt | undefined {
  const hasHistory = turns.some((turn) => turn.items.length > 0);
  const isPending = receipts.some((receipt) => isRecoveryMessageId(receipt.id) && receipt.status !== "sent");

  return hasHistory && !isPending
    ? { id: `${RECOVERY_ID_PREFIX}${crypto.randomUUID()}`, text: RECOVERY_PROMPT, status: "queued" }
    : undefined;
}

export function isQueueRecovery(state: Snapshot, receipts: Receipt[]) {
  const recovery = recoveryReceipt(state.turns, receipts);

  if (!recovery) {
    return false;
  }

  receipts.push(recovery);
  log().info({ id: recovery.id, threadId: state.threadId }, "recovery.queued");

  return true;
}
