import type { Receipt } from "../state/outbox";
import type { Snapshot } from "../lib/protocol";
import { updateTasks } from "./repository";
import { receiptEvent } from "./provenance";
import { recordEvent } from "./transitions";
import type { Ledger } from "./model";

/** Check receipt identity without reading input text.
@param id - Durable receipt identity.
@param event - Recorded event.
@returns Whether this input was already accepted.
*/
function hasReceipt(id: string, event: Ledger["events"][number]) {
  return event.id === `request:${id}`;
}

/** Reconcile accepted receipts without reinterpreting their original provenance on retries.
@param receipts - Durable accepted inputs.
@param scheduled - Known scheduled occurrence identities.
@param checkpoint - Parent ledger.
@returns Committed checkpoint.
*/
function reconcileReceipts(receipts: Receipt[], scheduled: Snapshot["scheduled"], checkpoint: Ledger) {
  let state = checkpoint;

  for (const receipt of receipts) {
    if (!state.events.some(hasReceipt.bind(undefined, receipt.id))) {
      state = recordEvent(state, receiptEvent(state.parentId, receipt, scheduled));
    }

    if (receipt.voiceContext) {
      state = recordEvent(state, {
        id: `history:${receipt.id}`,
        parentId: state.parentId,
        origin: "voice_history",
        text: "",
        contentRefs: [`receipt:${receipt.id}:voiceContext`],
        visibility: "internal",
        delivery: "not_delivered",
      });
    }
  }

  return state;
}

/** Persist request provenance at acceptance independently of background classification.
@param parentId - Owning parent.
@param receipts - Current durable outbox.
@param scheduled - Application-owned schedule ledger.
@returns Durable checkpoint.
*/
export function acceptTaskReceipts(parentId: string, receipts: Receipt[], scheduled: Snapshot["scheduled"]) {
  return updateTasks(
    parentId,
    "Accept receipts and preserve request identities",
    reconcileReceipts.bind(undefined, receipts, scheduled)
  );
}
