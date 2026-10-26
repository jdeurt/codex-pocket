import type { Receipt } from "../state/outbox";
import type { Snapshot } from "../lib/protocol";
import { isRecoveryMessageId } from "../state/recovery";
import { delegationMessagePrefix } from "../state/delegation-queue";
import type { TaskEvent } from "./model";

/** Allocate a stable request identity at acceptance, before task interpretation.
@param receiptId - Durable accepted input identity.
@returns Request identity within its parent's ledger.
*/
export function requestIdentity(receiptId: string) {
  return `request:${receiptId}`;
}

/** Derive trusted input provenance from application records, never from message markers.
@param parentId - Parent accepting this input.
@param receipt - Durable original input.
@param scheduled - Application-owned occurrence ledger.
@returns Source event retaining current intent separately from historical context.
*/
export function receiptEvent(parentId: string, receipt: Receipt, scheduled: Snapshot["scheduled"]): TaskEvent {
  let origin: TaskEvent["origin"] = receipt.source ? "voice_request" : "typed";

  if (isRecoveryMessageId(receipt.id)) {
    origin = "recovery";
  } else if (receipt.id.startsWith(delegationMessagePrefix)) {
    origin = "delegate_report";
  } else if (Object.hasOwn(scheduled, receipt.id)) {
    origin = "scheduled";
  }

  const isRequest = ["typed", "voice_request", "scheduled"].includes(origin);

  return {
    id: requestIdentity(receipt.id),
    parentId,
    receiptId: receipt.id,
    voiceSource: receipt.source,
    requestId: isRequest ? requestIdentity(receipt.id) : undefined,
    origin,
    text: receipt.source?.intent ?? (receipt.source ? "" : receipt.text),
    occurrenceId: origin === "scheduled" ? receipt.id : undefined,
    contentRefs: [`receipt:${receipt.id}`],
    references: receipt.source?.intentContext ?? [],
    visibility: isRequest && origin !== "scheduled" ? "user" : "internal",
    delivery: "not_delivered",
  };
}
