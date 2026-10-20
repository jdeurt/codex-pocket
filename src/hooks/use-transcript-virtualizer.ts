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

function readLayout(virtualizer: MessageVirtualizer): TranscriptLayout {
  return {
    rows: virtualizer.getVirtualItems().map((row) => ({ ...row })),
    size: virtualizer.getTotalSize(),
    offset: virtualizer.scrollOffset ?? 0,
    height: virtualizer.scrollRect?.height ?? 0,
    atEnd: virtualizer.isAtEnd(),
  };
}

function sameRows(previous: VirtualItem[], next: VirtualItem[]) {
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
export function useTranscriptVirtualizer(
  options: MessageOptions,
  adjust?: MessageVirtualizer["shouldAdjustScrollPositionOnItemSizeChange"]
) {
  const [store] = useState(() => {
    const listeners = new Set<() => void>();
    const state: { layout: TranscriptLayout } = { layout: { rows: [], size: 0, offset: 0, height: 0, atEnd: true } };
    const publish = (instance: MessageVirtualizer) => {
      const next = readLayout(instance);
      const previous = state.layout;

      if (
        sameRows(previous.rows, next.rows) &&
        next.size === previous.size &&
        next.offset === previous.offset &&
        next.height === previous.height &&
        next.atEnd === previous.atEnd
      ) {
        return;
      }

      state.layout = next;

      for (const listener of listeners) {
        listener();
      }
    };
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      observeElementOffset,
      observeElementRect,
      scrollToFn: elementScroll,
      ...options,
      onChange: publish,
    });
    state.layout = readLayout(virtualizer);

    return {
      virtualizer,
      configure: (nextOptions: MessageOptions, nextAdjust: typeof adjust) => {
        virtualizer.setOptions({
          observeElementOffset,
          observeElementRect,
          scrollToFn: elementScroll,
          ...nextOptions,
          onChange: (instance, sync) => {
            publish(instance);
            nextOptions.onChange?.(instance, sync);
          },
        });
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = nextAdjust;
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
  const layout = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const virtualizer = store.virtualizer;
  useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
  useLayoutEffect(() => {
    store.configure(options, adjust);
  });

  return { virtualizer, layout };
}
