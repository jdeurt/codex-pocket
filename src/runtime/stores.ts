import { createStore, type StoreApi } from "zustand/vanilla";
import { type QueuedMessage, type Snapshot } from "../lib/protocol";
import { type FileAttachment } from "../lib/attachments";
import { type VoiceSegment } from "../lib/voice-history";
import { acknowledgedDelivery, receivedThread, stagedMessage, type ThreadState } from "../state/thread";
import { reconcileCaptions, type VoiceState } from "../state/voice";

/** Supply an explicit initial value to Zustand's fixed-signature initializer.
@param state - Isolated initial data.
@returns The same initial data.
*/
function initialState<T>(state: T) {
  return state;
}

/** Allocate an observable runtime store around pure initial data.
@param state - Data owned by this store instance.
@returns Zustand's effectful subscription and publication boundary.
*/
export function observable<T>(state: T) {
  return createStore<T>((initialState<T>).bind(undefined, state));
}

export type ThreadStore = StoreApi<ThreadState>;
export type VoiceStore = StoreApi<VoiceState>;

/** Publish a reconciled snapshot atomically.
@param store - Conversation runtime owner.
@param state - Incoming canonical data.
@param isConnected - Transport status.
*/
export function publishThread(store: ThreadStore, state: Snapshot, isConnected: boolean) {
  store.setState(receivedThread(store.getState(), state, isConnected));
}

/** Publish an optimistic message atomically.
@param store - Conversation runtime owner.
@param id - Durable receipt identity.
@param text - Original message text.
@param attachments - Original upload receipts.
*/
export function stageMessage(store: ThreadStore, id: string, text: string, attachments?: FileAttachment[]) {
  store.setState(stagedMessage(store.getState(), id, text, attachments));
}

/** Publish a delivery acknowledgment atomically.
@param store - Conversation runtime owner.
@param id - Durable receipt identity.
@param status - Delivery result.
*/
export function updateDelivery(store: ThreadStore, id: string, status: QueuedMessage["status"]) {
  store.setState(acknowledgedDelivery(store.getState(), id, status));
}

/** Publish captions without delaying media delivery.
@param store - Voice runtime owner.
@param entries - Live or persisted captions.
*/
export function mergeCaptions(store: VoiceStore, entries: VoiceSegment[]) {
  store.setState({ segments: reconcileCaptions(store.getState().segments, entries) });
}
