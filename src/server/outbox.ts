import { type QueuedMessage, queuedMessageSchema } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { type FileAttachment } from "../lib/attachments";
import { z } from "zod";

const RECEIPT_LIMIT = 1000;

export interface Receipt {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  status: QueuedMessage["status"];
}
export const outboxSchema = z.object({ threadId: z.string(), receipts: z.array(queuedMessageSchema) });

export async function restoreReceipts(threadId: string) {
  const outbox = outboxSchema.parse(await readLocal("outbox.json", { threadId, receipts: [] }));

  if (outbox.threadId !== threadId && outbox.receipts.some((r) => r.status !== "sent")) {
    throw new Error(
      "The previous thread has undelivered messages. Resolve .local/outbox.json before changing threads."
    );
  }

  const receipts = outbox.threadId === threadId ? outbox.receipts : [];

  for (const receipt of receipts) {
    if (receipt.status === "sending") {
      receipt.status = "unknown";
    }
  }

  return receipts;
}

export async function persistReceipts(threadId: string, receipts: Receipt[]) {
  const recent = [
    // Attachment receipts also hold the saved message's display metadata.
    ...receipts.filter((r) => r.status === "sent" && r.attachments?.length),
    ...receipts.filter((r) => r.status === "sent" && !r.attachments?.length).slice(-RECEIPT_LIMIT),
    ...receipts.filter((r) => r.status !== "sent"),
  ];

  await writeLocal("outbox.json", { threadId, receipts: recent });

  return recent;
}
