import { type Snapshot, type Turn, type Item, type QueuedMessage, string } from "../lib/protocol";

/** Restore receipt-backed display fields without changing canonical native items.
@param receipts - Explicit durable receipt index.
@param item - Original native item.
@returns Original item or detached receipt-backed display fields.
*/
function receiptItem(receipts: ReadonlyMap<string, QueuedMessage>, item: Item): Item {
  if (item.type !== "userMessage") {
    return item;
  }

  const attached = receipts.get(String(item.clientId));
  const contextual = receipts.get(string(item.clientId) || item.id);

  if (!attached?.attachments?.length && !contextual?.voiceContext) {
    return item;
  }

  return {
    ...item,
    ...(attached?.attachments?.length && { attachments: attached.attachments, pocketAttachmentText: attached.text }),
    ...(contextual?.voiceContext && { content: [{ type: "text", text: contextual.text }] }),
  };
}

/** Project one native turn using immutable receipt metadata.
@param receipts - Explicit durable receipt index.
@param turn - Canonical native turn.
@returns Detached display turn.
*/
function receiptTurn(receipts: ReadonlyMap<string, QueuedMessage>, turn: Turn): Turn {
  return { ...turn, items: Array.from(turn.items, receiptItem.bind(undefined, receipts)) };
}

/** Restore attachment and voice display metadata in one immutable pass.
@param state - Canonical native snapshot.
@param receipts - Durable submissions.
@returns Snapshot retaining native identity with corrected user-visible content.
*/
export function receiptProjection(state: Snapshot, receipts: readonly QueuedMessage[]): Snapshot {
  const indexed = new Map<string, QueuedMessage>();

  for (const receipt of receipts) {
    indexed.set(receipt.id, receipt);
  }

  return { ...state, turns: Array.from(state.turns, receiptTurn.bind(undefined, indexed)) };
}
