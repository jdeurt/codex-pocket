"use client";
import { type Snapshot, initialSnapshot } from "@/lib/protocol";
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const RECONNECT_DELAY_MS = 3000;
const initial = { state: initialSnapshot, connected: false };
const store: { current: typeof initial; stop?: () => void } = { current: initial };

function publish(state: Snapshot, connected: boolean) {
  store.current = { state, connected };

  for (const listener of listeners) {
    listener();
  }
}

function start() {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    source?.close();
    clearTimeout(retry);
    source = new EventSource("/api/events");
    source.addEventListener("message", (event: MessageEvent<string>) => {
      const state = JSON.parse(event.data) as Snapshot;
      publish(state, true);

      if (state.connection !== "disconnected") {
        return;
      }

      source?.close();
      retry = setTimeout(connect, RECONNECT_DELAY_MS);
    });
    source.addEventListener("error", () => publish(store.current.state, false));
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
