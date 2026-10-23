import { type MessageSource, type QueuedMessage, queuedMessageSchema } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { type FileAttachment } from "../lib/attachments";
import { z } from "zod";

const RECEIPT_LIMIT = 1000;

export interface Receipt {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  source?: MessageSource;
  status: QueuedMessage["status"];
}
export const outboxSchema = z.object({ threadId: z.string(), receipts: z.array(queuedMessageSchema) });

/**
Reject a parent switch while the previous parent's outbox contains unresolved delivery.
@param outbox - Persisted outbox validated by its shared schema.
@param threadId - Current configured parent identity.
@returns The current parent's receipts, or an empty list after a safe parent switch.
*/
function ownedReceipts(outbox: z.infer<typeof outboxSchema>, threadId: string) {
  if (outbox.threadId !== threadId && outbox.receipts.some((receipt) => receipt.status !== "sent")) {
    throw new Error(
      "The previous thread has undelivered messages. Resolve .local/outbox.json before changing threads."
    );
  }

  return outbox.threadId === threadId ? outbox.receipts : [];
}

/**
Restore saved receipts and preserve interrupted sends as unknown without replay.
@param threadId - Configured parent that must own any undelivered messages.
@param pocketId - Optional named-Pocket private namespace.
@returns Restored receipts scoped to this parent.
*/
export async function restoreReceipts(threadId: string, pocketId?: string) {
  const outbox = outboxSchema.parse(
    await readLocal(pocketId ? `pockets/${pocketId}/outbox.json` : "outbox.json", { threadId, receipts: [] })
  );

  const receipts = ownedReceipts(outbox, threadId);

  for (const receipt of receipts) {
    if (receipt.status === "sending") {
      receipt.status = "unknown";
    }
  }

  return receipts;
}

/**
Persist unresolved and attachment receipts while bounding plain completed history.
@param threadId - Parent conversation owning these receipts.
@param receipts - Current ordered delivery records.
@param pocketId - Optional named-Pocket private namespace.
@returns Exact retained receipt list written to private storage.
*/
export async function persistReceipts(threadId: string, receipts: Receipt[], pocketId?: string) {
  const recent = [
    // Attachment receipts also hold the saved message's display metadata.
    ...receipts.filter((r) => r.status === "sent" && r.attachments?.length),
    ...receipts.filter((r) => r.status === "sent" && !r.attachments?.length).slice(-RECEIPT_LIMIT),
    ...receipts.filter((r) => r.status !== "sent"),
  ];

  await writeLocal(pocketId ? `pockets/${pocketId}/outbox.json` : "outbox.json", { threadId, receipts: recent });

  return recent;
}
