"use client";
import { useEffect } from "react";
import { useStore } from "zustand";
import { usePocketClient } from "../providers/pocket-state";

/** Bind the rendering surface to voice state; media and history run in independent services.
@param threadId - Connected conversation identity, absent while disconnected.
@returns Live state, service actions and spectrum accessors.
*/
export function useRealtime(threadId?: string) {
  const { voice, realtime } = usePocketClient();
  const state = useStore(voice);

  useEffect(() => (threadId ? realtime.history.connect() : undefined), [realtime, threadId]);

  return {
    ...state,
    error: state.error || state.historyError,
    start: realtime.start,
    stop: realtime.stop,
    dismissError: realtime.dismissError,
    ...realtime.analysers(),
  };
}
