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
  const confirmed = new Set<string>();
  const remaining: QueuedMessage[] = [];
  const queue = new Map<string, QueuedMessage>();

  for (const turn of state.turns) {
    for (const item of turn.items) {
      if (isVisibleUserItem(item)) {
        confirmed.add(string(item.clientId));
      }
    }
  }

  for (const message of pending) {
    if (!confirmed.has(message.id)) {
      remaining.push(message);
    }
  }

  for (const message of state.queue) {
    if (!confirmed.has(message.id)) {
      queue.set(message.id, message);
    }
  }

  for (const message of remaining) {
    if (!queue.has(message.id) || message.status === "sent") {
      queue.set(message.id, message);
    }
  }

  return { state: { ...state, queue: queue.values().toArray() }, pending: remaining };
}
