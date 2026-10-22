"use client";
import {
  type VirtualItem,
  Virtualizer,
  type VirtualizerOptions,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/react-virtual";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";

type MessageVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>;
type MessageOptions = Omit<
  VirtualizerOptions<HTMLDivElement, HTMLElement>,
  "observeElementOffset" | "observeElementRect" | "scrollToFn"
> & { scrollToFn?: VirtualizerOptions<HTMLDivElement, HTMLElement>["scrollToFn"] };
export interface TranscriptLayout {
  rows: VirtualItem[];
  size: number;
  offset: number;
  height: number;
  atEnd: boolean;
}

/**
Preserve the native end position when its following viewport changes height.
@param instance - Existing TanStack owner of the transcript's measurements and scrolling.
@param onRect - Native callback that adopts the next viewport rectangle.
@returns Cleanup for the native viewport observer.
*/
const observeTranscriptRect: MessageVirtualizer["options"]["observeElementRect"] = (instance, onRect) =>
  observeElementRect(instance, (rect) => {
    const previousHeight = instance.scrollRect?.height;
    const shouldPreserveEnd =
      instance.options.anchorTo === "end" &&
      instance.options.followOnAppend &&
      previousHeight !== undefined &&
      previousHeight > 0 &&
      previousHeight !== rect.height &&
      Math.max(instance.getTotalSize() - previousHeight - (instance.scrollOffset ?? 0), 0) <=
        instance.options.scrollEndThreshold &&
      (instance.targetWindow?.visualViewport?.scale ?? 1) === 1;

    // Decide against the previous viewport before the native callback replaces it.
    onRect(rect);

    if (shouldPreserveEnd) {
      instance.scrollToEnd();
    }
  });

/**
Copy native virtual items and scalar measurements into a React render snapshot.
@param virtualizer - Existing TanStack instance that owns all measurement and scrolling.
@returns A detached layout snapshot for external-store subscribers.
*/
function readLayout(virtualizer: MessageVirtualizer): TranscriptLayout {
  return {
    rows: virtualizer.getVirtualItems().map((row) => ({ ...row })),
    size: virtualizer.getTotalSize(),
    offset: virtualizer.scrollOffset ?? 0,
    height: virtualizer.scrollRect?.height ?? 0,
    atEnd: virtualizer.isAtEnd(),
  };
}

/**
Compare copied native measurements without relying on mutable row-object identity.
@param previous - Previously published virtual rows.
@param next - Newly copied virtual rows.
@returns Whether their keys, positions, sizes and lanes match.
*/
function hasSameRows(previous: VirtualItem[], next: VirtualItem[]) {
  return (
    previous.length === next.length &&
    previous.every((row, index) => {
      const other = next[index];

      return (
        row.key === other.key &&
        row.index === other.index &&
        row.start === other.start &&
        row.end === other.end &&
        row.size === other.size &&
        row.lane === other.lane
      );
    })
  );
}

// TanStack owns measurements, anchors and scrolling. React renders an immutable
// subscription snapshot so the compiler never memoizes reads of its mutable instance.
/**
Subscribe React to immutable snapshots while TanStack owns measurement, anchoring and following.
Core lifecycle wiring mirrors the official adapter; _didMount/_willUpdate remain undocumented core APIs.
@param options - Native TanStack options with the existing element observers and scroll function defaults.
@param [adjust] - Native measurement-adjustment decision for this transcript.
@returns The existing virtualizer instance and its reactive layout snapshot.
*/
export function useTranscriptVirtualizer(
  options: MessageOptions,
  adjust?: MessageVirtualizer["shouldAdjustScrollPositionOnItemSizeChange"]
) {
  const [store] = useState(() => {
    const listeners = new Set<() => void>();
    const state: { layout: TranscriptLayout } = { layout: { rows: [], size: 0, offset: 0, height: 0, atEnd: true } };
    const cacheLayout = (instance: MessageVirtualizer) => {
      const next = readLayout(instance);
      const previous = state.layout;

      if (
        hasSameRows(previous.rows, next.rows) &&
        next.size === previous.size &&
        next.offset === previous.offset &&
        next.height === previous.height &&
        next.atEnd === previous.atEnd
      ) {
        return previous;
      }

      state.layout = next;

      return next;
    };
    const publish = (instance: MessageVirtualizer) => {
      const previous = state.layout;
      const next = cacheLayout(instance);

      if (previous === next) {
        return;
      }

      for (const listener of listeners) {
        listener();
      }
    };
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      observeElementOffset,
      observeElementRect: observeTranscriptRect,
      scrollToFn: elementScroll,
      ...options,
      onChange: publish,
    });

    state.layout = readLayout(virtualizer);

    return {
      configure: (nextOptions: MessageOptions, nextAdjust: typeof adjust) => {
        virtualizer.setOptions({
          observeElementOffset,
          observeElementRect: observeTranscriptRect,
          scrollToFn: elementScroll,
          ...nextOptions,
          onChange: (instance, sync) => {
            publish(instance);
            nextOptions.onChange?.(instance, sync);
          },
        });
        const initialOffset =
          typeof nextOptions.initialOffset === "function"
            ? nextOptions.initialOffset()
            : (nextOptions.initialOffset ?? 0);
        const restoredAnchor = nextOptions.initialMeasurementsCache?.find((item) => item.end > initialOffset);
        const isRestoring =
          restoredAnchor !== undefined && nextOptions.anchorTo === "start" && !nextOptions.useCachedMeasurements;

        // Keep the saved row's top stable even if its own image temporarily
        // shrinks the row above the fold while the bookmark is being restored.
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
          nextAdjust ?? (isRestoring ? (item) => item.index < restoredAnchor.index : undefined);
        cacheLayout(virtualizer);

        return virtualizer;
      },
      commit: (renderedLayout: TranscriptLayout) => {
        // Native anchor/follow updates require the new sizer to be committed.
        if (state.layout !== renderedLayout) {
          return;
        }

        virtualizer._willUpdate();
        publish(virtualizer);
      },
      getSnapshot: () => state.layout,
      subscribe: (listener: () => void) => {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
    };
  });
  // Configure before React commits new rows: native follow checks the previous DOM extent.
  const virtualizer = store.configure(options, adjust);
  const layout = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
  useLayoutEffect(() => {
    store.commit(layout);
  });

  return { virtualizer, layout };
}
