"use client";
import { ESTIMATED_MESSAGE_HEIGHT, bufferedMessages } from "@/lib/transcript-virtualization";
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
import { type VirtualItem, elementScroll } from "@tanstack/react-virtual";
import { ChatMessage } from "./chat-message";
import { useTranscriptVirtualizer } from "@/hooks/use-transcript-virtualizer";
import { collapseDetail } from "@/lib/disclosure-click";

export type ActivityMeasurements = Map<string, VirtualItem[]>;

/**
Measure nested activity messages while the outer TanStack list owns navigation and following.
@param props - Stable group identity, native items, shared viewport and saved measurements.
@returns The existing bounded virtual activity list.
*/
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
}) {
  const content = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(origin);
  const getItemKey = useCallback((index: number) => string(items[index].clientId) || items[index].id, [items]);
  const { virtualizer, layout } = useTranscriptVirtualizer(
    {
      count: items.length,
      getScrollElement: () => viewport.current,
      getItemKey,
      initialOffset: () => viewport.current?.scrollTop ?? 0,
      estimateSize: () => ESTIMATED_MESSAGE_HEIGHT,
      anchorTo: !suspended && scrollOffset >= margin && scrollOffset < end ? "end" : "start",
      followOnAppend: false,
      scrollEndThreshold: -1,
      initialMeasurementsCache: measurements.get(id),
      scrollMargin: margin,
      rangeExtractor: (range) => (nearby ? bufferedMessages(range) : []),
      overscan: items.length,
      useCachedMeasurements: suspended,
      // Inner writes only preserve a reader's keyed/measurement anchor.
      // The outer TanStack list owns navigation and append following.
      scrollToFn: (offset, options, instance) => {
        if (!suspended) {
          elementScroll(offset, options, instance);
        }
      },
    },
    (item, _delta, instance) => {
      const offset = instance.scrollOffset ?? 0;

      // A fully preceding panel is anchored by the outer list. While reading
      // inside it, only its inner message list can identify the visible anchor.
      return !suspended && offset < margin + instance.getTotalSize() && item.end <= offset;
    }
  );

  const measure = useCallback(
    (element: HTMLElement | null) => {
      if (!suspended) {
        virtualizer.measureElement(element);
      }
    },
    [virtualizer, suspended]
  );
  const rows = layout.rows;

  useLayoutEffect(() => {
    const element = content.current;
    const scroller = viewport.current;

    if (element && scroller && !suspended) {
      // The outer sizer can move this panel without changing its virtual origin.
      // Refresh scrollMargin when either list changes its geometry or offset.
      setMargin(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    }
  }, [origin, end, scrollOffset, layout.size, viewport, suspended]);

  useLayoutEffect(() => {
    return () => {
      measurements.set(id, virtualizer.takeSnapshot());
    };
  }, [virtualizer, id, measurements]);

  return (
    <div ref={content} data-activity-virtualizer={id} style={{ height: layout.size, position: "relative" }}>
      <ul
        aria-label="Activity messages"
        className="absolute top-0 left-0 w-full min-w-0"
        style={{ transform: `translateY(${String((rows[0]?.start ?? margin) - margin)}px)` }}
      >
        {rows.map((row) => (
          <li
            key={row.key}
            data-index={row.index}
            data-transcript-row={`${turnId}/${String(row.key)}`}
            aria-posinset={row.index + 1}
            aria-setsize={items.length}
            ref={measure}
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

/**
Compose activity disclosure with its measured inner transcript and native open state.
@param props - Group identity, items, disclosure callbacks, viewport and suspension state.
@returns The existing expandable activity panel.
*/
export function VirtualizedActivity({
  id,
  turnId,
  items,
  open,
  onOpenChange,
  viewport,
  origin,
  nearby,
  end,
  scrollOffset,
  measurements,
  suspended,
}: {
  id: string;
  turnId: string;
  items: Item[];
  open: boolean;
  onOpenChange: () => void;
  viewport: RefObject<HTMLDivElement | null>;
  origin: number;
  nearby: boolean;
  end: number;
  scrollOffset: number;
  measurements: ActivityMeasurements;
  suspended: boolean;
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
          onClick={(event) => {
            collapseDetail(event, onOpenChange);
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
            />
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
