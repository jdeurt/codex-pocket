"use client";

import { ESTIMATED_MESSAGE_HEIGHT, bufferedMessages, measureTranscriptRow } from "@/lib/transcript-virtualization";
import { type Item, string } from "@/lib/protocol";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { type VirtualItem, elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { ChatMessage } from "./chat-message";
import type { TranscriptScrollOffset } from "@/lib/transcript-scroll-offset";
import type { TranscriptSuspension } from "@/lib/transcript-suspension";
import { useTranscriptMeasurements } from "@/hooks/use-transcript-measurements";

export type ActivityMeasurements = Map<string, VirtualItem[]>;

function ActivityMessages({
  id,
  turnId,
  items,
  viewport,
  origin,
  nearby,
  end,
  scrollOffset,
  measurements,
  suspended,
  suspension,
  offsets,
  cached,
}: {
  id: string;
  turnId: string;
  items: Item[];
  viewport: RefObject<HTMLDivElement | null>;
  origin: number;
  nearby: boolean;
  end: number;
  scrollOffset: number;
  measurements: ActivityMeasurements;
  suspended: boolean;
  suspension: TranscriptSuspension;
  offsets: TranscriptScrollOffset;
  cached: boolean;
}) {
  "use no memo";
  const content = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(origin);
  const getItemKey = useCallback((index: number) => string(items[index].clientId) || items[index].id, [items]);
  // eslint-disable-next-line react-hooks/incompatible-library -- Mutable controller; opted out above.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: items.length,
    getScrollElement: () => viewport.current,
    observeElementOffset: offsets.observe,
    getItemKey,
    initialOffset: () => viewport.current?.scrollTop ?? 0,
    estimateSize: () => ESTIMATED_MESSAGE_HEIGHT,
    anchorTo: !suspended && !suspension.blocked && scrollOffset >= margin && scrollOffset < end ? "end" : "start",
    followOnAppend: false,
    scrollEndThreshold: -1,
    initialMeasurementsCache: measurements.get(id),
    scrollMargin: margin,
    rangeExtractor: (range) => (nearby ? bufferedMessages(range) : []),
    overscan: items.length,
    measureElement: measureTranscriptRow,
    useCachedMeasurements: cached,
    // Inner writes only preserve a reader's keyed/measurement anchor.
    // Navigation and bottom following remain with the outer controller.
    scrollToFn: (offset, options, instance) => {
      if (!suspended && !suspension.blocked) {
        elementScroll(offset, { ...options, behavior: "instant" }, instance);
      }
    },
  });

  useLayoutEffect(() => {
    const element = content.current;
    const scroller = viewport.current;

    if (element && scroller && !cached) {
      // Supported scrollMargin composes virtual lists in one scroll element.
      setMargin(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    }
  }, [origin, viewport, cached]);

  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const offset = instance.scrollOffset ?? 0;

      // A fully preceding panel is anchored by the outer list. While reading
      // inside it, only its inner message list can identify the visible anchor.
      return !suspension.blocked && offset < margin + instance.getTotalSize() && item.end <= offset;
    };

    return () => {
      measurements.set(id, virtualizer.takeSnapshot());
    };
  }, [virtualizer, id, margin, measurements, suspension]);

  useTranscriptMeasurements(virtualizer, suspension, content, ":scope > ul > li");

  const rows = virtualizer.getVirtualItems();

  return (
    <div
      ref={content}
      data-activity-virtualizer={id}
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      <ul
        aria-label="Activity messages"
        className="absolute top-0 left-0 w-full min-w-0"
        style={{ transform: `translateY(${(rows[0]?.start ?? margin) - margin}px)` }}
      >
        {rows.map((row) => (
          <li
            key={row.key}
            data-index={row.index}
            data-transcript-row={`${turnId}/${row.key}`}
            aria-posinset={row.index + 1}
            aria-setsize={items.length}
            ref={virtualizer.measureElement}
            className="message-flow min-w-0"
            style={{ paddingBottom: row.index < items.length - 1 ? "var(--message-block-gap)" : 0 }}
          >
            <ChatMessage item={items[row.index]} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VirtualizedActivity({
  id,
  turnId,
  items,
  open,
  onOpenChange,
  onSettled,
  viewport,
  origin,
  nearby,
  end,
  scrollOffset,
  measurements,
  suspended,
  suspension,
  offsets,
  cached,
}: {
  id: string;
  turnId: string;
  items: Item[];
  open: boolean;
  onOpenChange: () => void;
  onSettled: () => void;
  viewport: RefObject<HTMLDivElement | null>;
  origin: number;
  nearby: boolean;
  end: number;
  scrollOffset: number;
  measurements: ActivityMeasurements;
  suspended: boolean;
  suspension: TranscriptSuspension;
  offsets: TranscriptScrollOffset;
  cached: boolean;
}) {
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        <TraceCollapsibleTrigger className="min-h-11" variant="activity">
          <TraceLine size="md" variant="activity">
            <TraceTitle>{open ? "Hide activity" : "Show activity"}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent
          variant="messages"
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === "height") {
              onSettled();
            }
          }}
        >
          <div className="activity-messages">
            <ActivityMessages
              id={id}
              turnId={turnId}
              items={items}
              viewport={viewport}
              origin={origin}
              nearby={nearby}
              end={end}
              scrollOffset={scrollOffset}
              measurements={measurements}
              suspended={suspended}
              suspension={suspension}
              offsets={offsets}
              cached={cached}
            />
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
