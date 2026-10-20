import { type QueuedMessage, type Snapshot, string } from "./protocol";

/**
Merge local deliveries with server state and remove messages confirmed in the transcript.
@param state - Current normalized server snapshot, left unchanged.
@param pending - Locally retained deliveries, left unchanged.
@returns A new snapshot and pending list with confirmed client IDs removed.
*/
export function reconcileDeliveries(state: Snapshot, pending: QueuedMessage[]) {
  const confirmed = new Set(
    state.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "userMessage").map((item) => string(item.clientId))
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
