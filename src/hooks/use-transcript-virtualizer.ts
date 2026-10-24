"use client";
import { useStore } from "zustand";
import { useLayoutEffect, useReducer, useSyncExternalStore } from "react";
import { TranscriptVirtualizer, type MessageOptions, type MessageVirtualizer } from "../runtime/transcript-virtualizer";

export type { TranscriptLayout } from "../state/transcript-layout";

/** Allocate one unmounted native measurement owner.
@param isFollowing - Initial reader preference, when this runtime owns following.
@param options - Initial native configuration.
@returns Runtime scoped to this mounted transcript.
*/
function createTranscript(isFollowing: boolean | undefined, options: MessageOptions) {
  return new TranscriptVirtualizer(options, isFollowing);
}

/** Keep the runtime stable until its React owner remounts.
@param runtime - Current transcript owner.
@returns The same runtime instance.
*/
function retainTranscript(runtime: TranscriptVirtualizer) {
  return runtime;
}

/** Connect React to detached snapshots while native code owns measurements and scrolling.
@param options - Native virtualizer options.
@param adjust - Optional native size-adjustment decision.
@param isFollowing - Restored outer-transcript follow preference.
@returns Native bindings, follow store and detached layout for this render.
*/
export function useTranscriptVirtualizer(
  options: MessageOptions,
  adjust?: MessageVirtualizer["shouldAdjustScrollPositionOnItemSizeChange"],
  isFollowing?: boolean
) {
  const [store] = useReducer(retainTranscript, options, createTranscript.bind(undefined, isFollowing));
  const follow = useStore(store.follow);
  const virtualizer = store.configure(options, adjust);
  const layout = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useLayoutEffect(store.mount, [store]);
  useLayoutEffect(store.commit.bind(undefined, layout));

  return { virtualizer, layout, follow, followStore: store.follow };
}
