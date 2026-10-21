import { type Item, type QueuedMessage, type Snapshot, string } from "./protocol";
import { hasMessageText } from "./turn-messages";

/**
Keep a local delivery until its canonical user item can actually render.
@param item - Candidate canonical native item.
@returns Whether the user item has displayable text or attachments.
*/
function isVisibleUserItem(item: Item) {
  return item.type === "userMessage" && (hasMessageText(item) || !!item.attachments?.length || !!item.images?.length);
}

/**
Merge local deliveries with server state and remove messages confirmed in the transcript.
@param state - Current normalized server snapshot, left unchanged.
@param pending - Locally retained deliveries, left unchanged.
@returns A new snapshot and pending list with confirmed client IDs removed.
*/
export function reconcileDeliveries(state: Snapshot, pending: QueuedMessage[]) {
  const confirmed = new Set(
    state.turns.flatMap((turn) =>
      turn.items.filter((item) => isVisibleUserItem(item)).map((item) => string(item.clientId))
    )
  );
  const remaining = pending.filter((message) => !confirmed.has(message.id));
  const queue = new Map(
    state.queue.filter((message) => !confirmed.has(message.id)).map((message) => [message.id, message])
  );

  for (const message of remaining) {
    if (!queue.has(message.id) || message.status === "sent") {
      queue.set(message.id, message);
    }
  }

  return { state: { ...state, queue: queue.values().toArray() }, pending: remaining };
}
