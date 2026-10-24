"use client";
import { ESTIMATED_MESSAGE_HEIGHT, activityRange } from "@/lib/transcript-virtualization";
import { type Item, string } from "@/lib/protocol";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { type VirtualItem } from "@tanstack/react-virtual";
import { ChatMessage } from "./chat-message";
import { useTranscriptVirtualizer } from "@/hooks/use-transcript-virtualizer";
import { collapseDetail } from "../runtime/disclosure-click";

import { useBoundCallback } from "../hooks/use-bound-callback";
import { transcriptViewport, scrollTranscript, attachTranscriptRow } from "../runtime/transcript-view";
import {
  type ActivityMeasurements,
  activityInitialOffset,
  shouldAdjustActivityItem,
  measureActivityMargin,
  retainActivityMeasurements,
} from "../runtime/activity-view";

export type { ActivityMeasurements } from "../runtime/activity-view";

/** Select a native item's stable client or source identity.
@param items - Canonical nested items.
@param index - Native requested index.
@returns Stable message identity.
*/
function activityItemKey(items: Item[], index: number) {
  return string(items[index].clientId) || items[index].id;
}

/** Supply the existing message estimate before measurement.
@returns Initial message height.
*/
function estimatedActivityHeight() {
  return ESTIMATED_MESSAGE_HEIGHT;
}

/** Render one nested message using explicit native geometry.
@param items - Canonical activity items.
@param turnId - Owning native turn.
@param measure - Runtime measurement ref callback.
@param row - Detached native row measurement.
@returns Keyed nested message row.
*/
function activityRow(items: Item[], turnId: string, measure: (element: HTMLElement | null) => void, row: VirtualItem) {
  return (
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
  );
}

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
  const [measuredMargin, setMargin] = useState<number>();
  const margin = measuredMargin ?? origin;
  const getItemKey = useBoundCallback(activityItemKey, items);
  const getScrollElement = useBoundCallback(transcriptViewport, viewport);
  const initialOffset = useBoundCallback(activityInitialOffset, viewport);
  const rangeExtractor = useBoundCallback(activityRange, nearby);
  const scrollToFn = useBoundCallback(scrollTranscript, suspended);
  const shouldAdjust = useBoundCallback(shouldAdjustActivityItem, suspended, margin);
  const { virtualizer, layout } = useTranscriptVirtualizer(
    {
      count: items.length,
      getScrollElement,
      getItemKey,
      initialOffset,
      estimateSize: estimatedActivityHeight,
      anchorTo: !suspended && scrollOffset >= margin && scrollOffset < end ? "end" : "start",
      followOnAppend: false,
      scrollEndThreshold: -1,
      initialMeasurementsCache: measurements.get(id),
      scrollMargin: margin,
      rangeExtractor,
      overscan: items.length,
      useCachedMeasurements: suspended,
      scrollToFn,
    },
    shouldAdjust
  );
  const measure = useBoundCallback(attachTranscriptRow, virtualizer, suspended);
  const measureMargin = useBoundCallback(measureActivityMargin, content, viewport, suspended, setMargin);
  const retainMeasurements = useBoundCallback(retainActivityMeasurements, measurements, id, virtualizer);
  const rows = layout.rows;

  useLayoutEffect(measureMargin, [measureMargin, origin, end, scrollOffset, layout.size]);
  useLayoutEffect(retainMeasurements, [retainMeasurements]);

  return (
    <div ref={content} data-activity-virtualizer={id} style={{ height: layout.size, position: "relative" }}>
      <ul
        aria-label="Activity messages"
        className="absolute top-0 left-0 w-full min-w-0"
        style={{ transform: `translateY(${String((rows[0]?.start ?? margin) - margin)}px)` }}
      >
        {Array.from(rows, activityRow.bind(undefined, items, turnId, measure))}
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
        <TraceCollapsibleContent variant="messages" onClick={collapseDetail.bind(undefined, onOpenChange)}>
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
