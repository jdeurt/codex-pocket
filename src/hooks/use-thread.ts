"use client";
import { type QueuedMessage, type Snapshot, initialSnapshot, snapshotSchema } from "@/lib/protocol";
import { clientError, reportClient } from "@/lib/client-logging";
import { type FileAttachment } from "@/lib/attachments";
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

function publish(state: Snapshot, connected: boolean) {
  store.latestState = state;
  const reconciled = reconcileDeliveries(state, store.pending);
  store.pending = reconciled.pending;
  store.current = { state: reconciled.state, connected };

  for (const listener of listeners) {
    listener();
  }
}

export function stageMessage(id: string, text: string, attachments?: FileAttachment[]) {
  store.pending = [
    ...store.pending.filter((message) => message.id !== id),
    { id, text, attachments, status: "sending" },
  ];
  publish(store.latestState, store.current.connected);
}

export function updateDelivery(id: string, status: QueuedMessage["status"]) {
  store.pending = store.pending.map((message) => (message.id === id ? { ...message, status } : message));
  publish(store.latestState, store.current.connected);
}

function start() {
  let lastSummary = "";
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    reportClient("sse.connecting");
    source?.close();
    clearTimeout(retry);
    source = new EventSource("/api/events");
    source.addEventListener("message", (event: MessageEvent<string>) => {
      let data: unknown;

      try {
        data = JSON.parse(event.data);
      } catch (error) {
        reportClient("sse.invalid_json", clientError(error), "error");

        return;
      }

      const parsed = snapshotSchema.safeParse(data);

      if (!parsed.success) {
        reportClient("sse.invalid_state", { error: parsed.error.message }, "error");

        return;
      }

      const state = parsed.data;
      const details = {
        connection: state.connection,
        activeTurnId: state.activeTurnId,
        model: state.model,
        effort: state.reasoningEffort,
        queued: state.queue.length,
        requests: state.requests.length,
      };
      const summary = JSON.stringify(details);

      if (summary !== lastSummary) {
        reportClient("sse.state", details);
        lastSummary = summary;
      }

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

const getSnapshot = () => store.current;
const getServerSnapshot = () => initial;

export function useThread() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
