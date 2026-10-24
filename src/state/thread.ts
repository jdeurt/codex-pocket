import { createStore } from "zustand/vanilla";
import { type QueuedMessage, type Snapshot, initialSnapshot } from "../lib/protocol";
import { type FileAttachment } from "../lib/attachments";
import { markNewContent } from "../lib/new-content";
import { reconcileDeliveries } from "../lib/deliveries";

/** Create an isolated conversation projection, shared by server hydration and client subscriptions.
@param initial - Public server snapshot for this Pocket only.
@returns Store with reconciliation and delivery actions; no network or browser resources.
*/
export function createThreadStore(initial: Snapshot = structuredClone(initialSnapshot)) {
  return createStore(() => ({
    state: initial,
    latestState: initial,
    connected: false,
    pending: [] as QueuedMessage[],
  }));
}

export type ThreadStore = ReturnType<typeof createThreadStore>;

/** Reconcile canonical messages with optimistic deliveries before publishing one atomic snapshot.
@param store - Scoped conversation store.
@param state - Latest server snapshot.
@param isConnected - Transport liveness independent of native agent connection.
*/
export function publishThread(store: ThreadStore, state: Snapshot, isConnected: boolean) {
  const current = store.getState();
  const reconciled = reconcileDeliveries(markNewContent(current.latestState, state), current.pending);

  store.setState({ latestState: state, state: reconciled.state, pending: reconciled.pending, connected: isConnected });
}

/** Retain an optimistic message until its canonical user item becomes visible.
@param store - Scoped conversation store.
@param id - Durable delivery identity.
@param text - Original message.
@param attachments - Original uploaded file receipts.
*/
export function stageMessage(store: ThreadStore, id: string, text: string, attachments?: FileAttachment[]) {
  store.setState(({ pending }) => ({
    pending: [...pending.filter((message) => message.id !== id), { id, text, attachments, status: "sending" }],
  }));
  const current = store.getState();

  publishThread(store, current.latestState, current.connected);
}

/** Record delivery acknowledgment without discarding the optimistic row prematurely.
@param store - Scoped conversation store.
@param id - Original delivery identity.
@param status - Confirmed or uncertain delivery status.
*/
export function updateDelivery(store: ThreadStore, id: string, status: QueuedMessage["status"]) {
  store.setState(({ pending }) => ({
    pending: pending.map((entry) => (entry.id === id ? { ...entry, status } : entry)),
  }));
  const current = store.getState();

  publishThread(store, current.latestState, current.connected);
}
