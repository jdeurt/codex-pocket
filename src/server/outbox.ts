import { readLocal, writeLocal } from "./local-state";
import type { QueuedMessage } from "../lib/protocol";

const RECEIPT_LIMIT = 1000;

export interface Receipt {
  id: string;
  text: string;
  status: QueuedMessage["status"];
}
interface Outbox {
  threadId: string;
  receipts: Receipt[];
}

export async function restoreReceipts(threadId: string) {
  const outbox = await readLocal<Outbox>("outbox.json", { threadId, receipts: [] });

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
    ...receipts.filter((r) => r.status === "sent").slice(-RECEIPT_LIMIT),
    ...receipts.filter((r) => r.status !== "sent"),
  ];
  await writeLocal("outbox.json", { threadId, receipts: recent });

  return recent;
}
