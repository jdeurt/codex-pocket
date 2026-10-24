"use client";
import { visibleThread } from "../state/thread";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { usePocketClient } from "../providers/pocket-state";

/** Select the rendered conversation without subscribing to internal delivery bookkeeping.
@returns Reconciled public snapshot and transport status.
*/
export function useThread() {
  const { thread } = usePocketClient();

  return useStore(thread, useShallow(visibleThread));
}
