import { type QueuedMessage, queuedMessageSchema } from "../lib/protocol";
import { findById, upsertById } from "../lib/identity";
import { z } from "zod";

export type Receipt = QueuedMessage;
export const outboxSchema = z.object({ threadId: z.string(), receipts: z.array(queuedMessageSchema) });
const RECEIPT_LIMIT = 1000;

/** Select unresolved deliveries without changing their identities or order.
@param receipts - Durable delivery history.
@returns Pending canonical queue.
*/
export function queuedReceipts(receipts: readonly Receipt[]) {
  const queue: Receipt[] = [];

  for (const receipt of receipts) {
    if (receipt.status !== "sent") {
      queue.push(receipt);
    }
  }

  return queue;
}

/** Preserve an interrupted native send as uncertain.
@param receipt - Saved delivery.
@returns Restored receipt without changing persisted input.
*/
function restoredReceipt(receipt: Receipt): Receipt {
  return receipt.status === "sending" ? { ...receipt, status: "unknown" } : receipt;
}

/** Restore a parent's saved receipts without replaying interrupted sends.
@param outbox - Validated durable envelope.
@param threadId - Requested parent identity.
@returns Detached restored receipts, with sending outcomes marked uncertain.
*/
export function restoredReceipts(outbox: z.infer<typeof outboxSchema>, threadId: string): Receipt[] {
  if (outbox.threadId !== threadId) {
    if (queuedReceipts(outbox.receipts).length > 0) {
      throw new Error(
        "The previous thread has undelivered messages. Resolve .local/outbox.json before changing threads."
      );
    }

    return [];
  }

  return Array.from(outbox.receipts, restoredReceipt);
}

/** Retain durable display provenance and unresolved work while bounding ordinary history.
@param receipts - Ordered durable submissions.
@returns Exact receipt envelope to persist.
*/
export function retainedReceipts(receipts: readonly Receipt[]) {
  const metadata: Receipt[] = [];
  const completed: Receipt[] = [];
  const pending: Receipt[] = [];

  for (const receipt of receipts) {
    if (receipt.status !== "sent") {
      pending.push(receipt);
    } else if (receipt.attachments?.length || receipt.voiceContext) {
      metadata.push(receipt);
    } else {
      completed.push(receipt);
    }
  }

  return [...metadata, ...completed.slice(-RECEIPT_LIMIT), ...pending];
}

/** Replace one receipt's delivery status without mutating caller-owned records.
@param receipts - Current ordered receipts.
@param id - Existing durable identity.
@param status - Confirmed next status.
@returns Next ordered receipt state.
*/
export function receiptStatus(receipts: readonly Receipt[], id: string, status: Receipt["status"]) {
  const receipt = findById(receipts, id);

  if (!receipt) {
    throw new Error("The delivery receipt no longer exists.");
  }

  return upsertById(receipts, { ...receipt, status });
}
