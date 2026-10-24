import { type QueuedMessage, type Snapshot } from "../lib/protocol";
import { type FileAttachment } from "../lib/attachments";
import { markNewContent } from "../lib/new-content";
import { findById, upsertById, withoutId } from "../lib/identity";
import { reconcileDeliveries } from "../lib/deliveries";

export interface ThreadState {
  state: Snapshot;
  latestState: Snapshot;
  connected: boolean;
  pending: QueuedMessage[];
  revision: number;
}

/** Create conversation data without opening a connection.
@param initial - Public server snapshot for this Pocket.
@returns Initial canonical and optimistic projection.
*/
export function threadState(initial: Snapshot): ThreadState {
  return { state: initial, latestState: initial, connected: false, pending: [], revision: 0 };
}

/** Reconcile an incoming snapshot and delivery receipts in one pure transition.
@param current - Current projection, left unchanged.
@param state - Latest server snapshot.
@param isConnected - Transport liveness independent of agent connection.
@returns New conversation state with deterministic reveal identities.
*/
export function receivedThread(current: ThreadState, state: Snapshot, isConnected: boolean): ThreadState {
  const revision = current.revision + 1;
  const reconciled = reconcileDeliveries(markNewContent(current.latestState, state, revision), current.pending);

  return { latestState: state, state: reconciled.state, pending: reconciled.pending, connected: isConnected, revision };
}

/** Retain an optimistic message until its canonical user item becomes visible.
@param current - Current conversation projection.
@param id - Durable delivery identity.
@param text - Original message.
@param attachments - Original uploaded file receipts.
@returns Next reconciled projection without publishing it.
*/
export function stagedMessage(current: ThreadState, id: string, text: string, attachments?: FileAttachment[]) {
  const pending = [...withoutId(current.pending, id), { id, text, attachments, status: "sending" as const }];

  return receivedThread({ ...current, pending }, current.latestState, current.connected);
}

/** Record acknowledgment without discarding an optimistic row prematurely.
@param current - Current conversation projection.
@param id - Durable delivery identity.
@param status - Confirmed or uncertain delivery status.
@returns Next reconciled projection without publishing it.
*/
export function acknowledgedDelivery(current: ThreadState, id: string, status: QueuedMessage["status"]) {
  const message = findById(current.pending, id);
  const pending = message ? upsertById(current.pending, { ...message, status }) : current.pending;

  return receivedThread({ ...current, pending }, current.latestState, current.connected);
}

/** Select public conversation state without internal delivery bookkeeping.
@param current - Current projection.
@returns Stable-shape rendering selection.
*/
export function visibleThread(current: ThreadState) {
  return { state: current.state, connected: current.connected };
}
