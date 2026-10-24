import { readLocal, writeLocal } from "./local-state";
import { outboxSchema, restoredReceipts, retainedReceipts, type Receipt } from "../state/outbox";

export { outboxSchema, type Receipt } from "../state/outbox";

/** Restore an owned durable outbox while preserving interrupted outcomes as uncertain.
@param threadId - Parent identity.
@param pocketId - Optional named-Pocket storage namespace.
@returns Restored immutable receipt state.
*/
export async function restoreReceipts(threadId: string, pocketId?: string) {
  const outbox = outboxSchema.parse(
    await readLocal(pocketId ? `pockets/${pocketId}/outbox.json` : "outbox.json", { threadId, receipts: [] })
  );

  return restoredReceipts(outbox, threadId);
}

/** Persist the pure receipt retention projection before publishing it.
@param threadId - Parent identity.
@param receipts - Current ordered durable submissions.
@param pocketId - Optional named-Pocket storage namespace.
@returns Exact retained state written to storage.
*/
export async function persistReceipts(threadId: string, receipts: Receipt[], pocketId?: string) {
  const recent = retainedReceipts(receipts);

  await writeLocal(pocketId ? `pockets/${pocketId}/outbox.json` : "outbox.json", { threadId, receipts: recent });

  return recent;
}
