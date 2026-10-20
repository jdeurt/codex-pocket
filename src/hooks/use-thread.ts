"use client";
import { type QueuedMessage, type Snapshot, initialSnapshot, snapshotSchema } from "@/lib/protocol";
import { clientError, reportClient } from "@/lib/client-logging";
import { type FileAttachment } from "@/lib/attachments";
import { ZodError } from "zod";
import { markNewContent } from "@/lib/new-content";
import { pocketUrl } from "@/lib/pockets";
import { reconcileDeliveries } from "@/lib/deliveries";
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const RECONNECT_DELAY_MS = 3000;
const initial = { state: initialSnapshot, connected: false };
const store: {
  current: typeof initial;
  latestState: Snapshot;
  pending: QueuedMessage[];
  stop?: () => void;
} = { current: initial, latestState: initialSnapshot, pending: [] };

/**
Reconcile server state with local deliveries before notifying transcript subscribers.
@param state - Normalized server snapshot retained as the latest authoritative state.
@param isConnected - Whether the browser currently receives the parent event stream.
*/
function publish(state: Snapshot, isConnected: boolean) {
  const reconciled = reconcileDeliveries(markNewContent(store.latestState, state), store.pending);

  store.latestState = state;
  store.pending = reconciled.pending;
  store.current = { state: reconciled.state, connected: isConnected };

  for (const listener of listeners) {
    listener();
  }
}

/**
Retain an optimistic message under its durable client ID before dispatching it.
@param id - Idempotent client message ID shared with the server.
@param text - Exact message text selected for delivery.
@param [attachments] - Normalized original-file receipts included with this message.
*/
export function stageMessage(id: string, text: string, attachments?: FileAttachment[]) {
  store.pending = [
    ...store.pending.filter((message) => message.id !== id),
    { id, text, attachments, status: "sending" },
  ];
  publish(store.latestState, store.current.connected);
}

/**
Update one locally retained delivery without replacing the authoritative server snapshot.
@param id - Client message ID already staged in the local outbox.
@param status - Existing queue/delivery state assigned to that message.
*/
export function updateDelivery(id: string, status: QueuedMessage["status"]) {
  store.pending = store.pending.map((message) => (message.id === id ? { ...message, status } : message));
  publish(store.latestState, store.current.connected);
}

/**
Decode each event once using the shared snapshot schema and retain distinct failure diagnostics.
@param text - Native EventSource message body.
@returns A normalized snapshot, or undefined after a JSON or schema failure is reported.
*/
function eventSnapshot(text: string) {
  try {
    return snapshotSchema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof ZodError) {
      reportClient("sse.invalid_state", { error: error.message }, "error");
    } else {
      reportClient("sse.invalid_json", clientError(error), "error");
    }
  }
}

/**
Log accepted connection metadata only when its serialized summary changes.
@param state - Snapshot already validated at the event boundary.
@param previous - Last logged summary owned by this stream subscription.
@returns The summary to retain for the next accepted event.
*/
function logSnapshotSummary(state: Snapshot, previous: string) {
  const details = {
    connection: state.connection,
    activeTurnId: state.activeTurnId,
    model: state.model,
    effort: state.reasoningEffort,
    queued: state.queue.length,
    requests: state.requests.length,
  };
  const summary = JSON.stringify(details);

  if (summary !== previous) {
    reportClient("sse.state", details);
  }

  return summary;
}

/**
Open the shared parent event stream and own its reconnect and wake listeners.
@returns Cleanup for the source, retry timer and native browser listeners.
*/
function start() {
  let lastSummary = "";
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    reportClient("sse.connecting");
    source?.close();
    clearTimeout(retry);
    source = new EventSource(pocketUrl("/api/events"));
    source.addEventListener("message", (event: MessageEvent<string>) => {
      const state = eventSnapshot(event.data);

      if (!state) {
        return;
      }

      lastSummary = logSnapshotSummary(state, lastSummary);
      publish(state, true);

      if (state.connection !== "disconnected") {
        return;
      }

      source?.close();
      retry = setTimeout(connect, RECONNECT_DELAY_MS);
    });
    source.addEventListener("error", () => {
      reportClient("sse.error", { readyState: source?.readyState, connection: store.latestState.connection }, "error");
      publish(store.latestState, false);
    });
  };
  const wake = () => {
    if (document.visibilityState === "visible") {
      connect();
    }
  };

  connect();
  globalThis.addEventListener("online", connect);
  document.addEventListener("visibilitychange", wake);

  return () => {
    clearTimeout(retry);
    source?.close();
    globalThis.removeEventListener("online", connect);
    document.removeEventListener("visibilitychange", wake);
  };
}

/**
Keep the shared parent stream active only while transcript subscribers exist.
@param listener - Stable React external-store callback.
@returns Cleanup that stops the stream after the final subscriber leaves.
*/
function subscribe(listener: () => void) {
  listeners.add(listener);
  store.stop ??= start();

  return () => {
    listeners.delete(listener);

    if (listeners.size > 0) {
      return;
    }

    store.stop?.();
    store.stop = undefined;
  };
}

/**
Read the current reconciled parent state without creating a new render snapshot.
@returns The cached state and transport status.
*/
const getSnapshot = () => store.current;
/**
Use the stable initial parent state during server rendering.
@returns The existing initial connection snapshot.
*/
const getServerSnapshot = () => initial;

/**
Subscribe the parent UI to reconciled server state and local delivery status.
@returns The current shared snapshot and transport connection flag.
*/
export function useThread() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
