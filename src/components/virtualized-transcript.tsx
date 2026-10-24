"use client";
import { useBoundCallback } from "../hooks/use-bound-callback";
import { measuredMessages, type TranscriptLayout } from "../state/transcript-layout";
import {
  transcriptViewport,
  measureTranscriptRow,
  scrollTranscript,
  attachTranscriptRow,
  resumeTranscriptFollow,
  maintainTranscriptEnd,
  preserveTranscriptOffset,
  connectTranscriptBookmark,
  trackTranscriptScroll,
  jumpToLatest,
} from "../runtime/transcript-view";
import { type ActivityMeasurements } from "./virtualized-activity";
import {
  Children,
  type ReactNode,
  type RefObject,
  useReducer,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  END_THRESHOLD,
  ESTIMATED_MESSAGE_HEIGHT,
  type TranscriptRow as Row,
  type TranscriptTurn,
  transcriptRange,
  transcriptRowKey,
  estimatedTranscriptRow,
  toggledTranscriptActivity,
  rowsForTurns,
} from "@/lib/transcript-virtualization";
import { MessageScroller, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { type VirtualItem } from "@tanstack/react-virtual";
import { type TranscriptBookmark, readTranscriptBookmark } from "../runtime/transcript-bookmark";
import { useTranscriptVirtualizer } from "@/hooks/use-transcript-virtualizer";
import { ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TranscriptEntry } from "./transcript-entry";
import { TranscriptFooter } from "./transcript-footer";

const PADDING_START = 24;
const PADDING_END = 10;
const LAST_ITEM = -1;

interface RowContext {
  rows: Row[];
  expanded: Set<string>;
  toggle: (id: string) => void;
  measure: (element: HTMLElement | null) => void;
  viewport: RefObject<HTMLDivElement | null>;
  layout: TranscriptLayout;
  measurements: ActivityMeasurements;
  suspended: boolean;
}

/** Render one native measurement with explicitly supplied transcript data and event bindings.
@param context - Immutable rendering inputs and runtime callbacks.
@param virtualRow - Native measured row.
@returns One stable keyed message or activity row.
*/
function transcriptRow(context: RowContext, virtualRow: VirtualItem) {
  const { rows, expanded, toggle, measure, viewport, layout, measurements: activityMeasurements, suspended } = context;

  const row = rows[virtualRow.index];
  const next = rows.at(virtualRow.index + 1);

  return (
    <li
      key={virtualRow.key}
      ref={measure}
      data-index={virtualRow.index}
      data-slot="message-scroller-item"
      data-transcript-row={row.id}
      data-activity-row={row.entry.kind === "activity" || undefined}
      aria-posinset={virtualRow.index + 1}
      aria-setsize={rows.length}
      className="message-flow min-w-0"
      style={{ paddingBottom: next ? "var(--message-block-gap)" : 0 }}
    >
      <TranscriptEntry
        row={row}
        virtualRow={virtualRow}
        open={expanded.has(row.id)}
        toggle={toggle.bind(undefined, row.id)}
        viewport={viewport}
        layout={layout}
        measurements={activityMeasurements}
        suspended={suspended}
      />
    </li>
  );
}

/** Render measured rows while forwarding native refs only as React props.
@param props - Detached measurements and explicit rendering context.
@returns Keyed transcript rows.
*/
function TranscriptRows({ messages, ...context }: RowContext & { messages: VirtualItem[] }) {
  return <>{Array.from(messages, transcriptRow.bind(undefined, context))}</>;
}

/** Allocate a measurement cache owned by one mounted transcript.
@returns Empty native activity measurement cache.
*/
function createActivityMeasurements(): ActivityMeasurements {
  return new Map();
}

/** Retain the initial saved bookmark for this keyed transcript.
@param bookmark - Initial restored bookmark.
@returns The same saved geometry.
*/
function retainBookmark(bookmark: TranscriptBookmark | undefined) {
  return bookmark;
}

/** Create disclosure data from the saved bookmark without changing it.
@param bookmark - Initial saved geometry and disclosure identities.
@returns Independent expanded-activity state.
*/
function expandedActivities(bookmark: TranscriptBookmark | undefined) {
  return new Set(bookmark?.expanded);
}

/**
Delegate transcript measurement, anchoring and append following to TanStack.
@param props - Canonical rows, pending controls and covered-parent suspension state.
@returns The existing measured rows and jump-to-latest control.
*/
function MeasuredTranscript({
  bookmark,
  storageKey,
  rows,
  footer,
  status,
  expanded,
  toggle,
  suspended,
  ready,
}: {
  bookmark?: TranscriptBookmark;
  storageKey?: string;
  rows: Row[];
  footer: ReactNode[];
  status?: ReactNode;
  expanded: Set<string>;
  toggle: (id: string) => void;
  suspended: boolean;
  ready: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const savedOffset = useRef<number | undefined>(undefined);
  const initialEnd = useRef(!bookmark || bookmark.atEnd);
  const [follow, setFollow] = useState(bookmark?.atEnd ?? true);

  const [activityMeasurements] = useState(createActivityMeasurements);
  const rangeExtractor = useBoundCallback(transcriptRange, rows, expanded);
  const getItemKey = useBoundCallback(transcriptRowKey, rows);
  const getScrollElement = useBoundCallback(transcriptViewport, viewport);
  const estimateSize = useBoundCallback(estimatedTranscriptRow, rows.length);
  const scrollToFn = useBoundCallback(scrollTranscript, suspended);
  const { virtualizer, layout } = useTranscriptVirtualizer({
    enabled: ready || rows.length > 0,
    count: rows.length + 1,
    getScrollElement,
    getItemKey,
    estimateSize,
    measureElement: measureTranscriptRow,
    initialOffset: bookmark?.offset ?? rows.length * ESTIMATED_MESSAGE_HEIGHT,
    initialMeasurementsCache: bookmark?.measurements,
    anchorTo: suspended || !follow ? "start" : "end",
    followOnAppend: !suspended && follow,
    scrollEndThreshold: END_THRESHOLD,
    paddingStart: PADDING_START,
    paddingEnd: PADDING_END,
    rangeExtractor,
    overscan: rows.length + 1,
    useCachedMeasurements: suspended,
    scrollToFn,
  });
  const measure = useBoundCallback(attachTranscriptRow, virtualizer, suspended);
  const items = layout.rows;
  const messages = measuredMessages(items, rows.length);
  const footerRow = items.at(LAST_ITEM);
  const blockStart = messages.at(0)?.start ?? footerRow?.start ?? 0;
  const resumeFollow = useBoundCallback(resumeTranscriptFollow, suspended, initialEnd, setFollow);
  const maintainEnd = useBoundCallback(maintainTranscriptEnd, virtualizer, initialEnd, suspended);
  const connectBookmark = useBoundCallback(connectTranscriptBookmark, storageKey, virtualizer, expanded);
  const trackScroll = useBoundCallback(trackTranscriptScroll, initialEnd);
  const preserveOffset = useBoundCallback(preserveTranscriptOffset, virtualizer, viewport, savedOffset, suspended);

  useLayoutEffect(maintainEnd, [maintainEnd, layout.size, layout.height]);
  useEffect(connectBookmark, [connectBookmark]);
  useLayoutEffect(preserveOffset, [preserveOffset]);

  return (
    <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
      <div className="min-h-0 flex-1">
        <MessageScroller>
          <MessageScrollerViewport
            ref={viewport}
            className="data-at-end:scroll-fade-none"
            data-at-end={layout.atEnd || undefined}
            data-scroll-suspended={suspended || undefined}
            preserveScrollOnPrepend={false}
            style={{ overflowAnchor: "none", overflowY: suspended ? "hidden" : undefined }}
            onWheel={resumeFollow}
            onTouchStart={resumeFollow}
            onPointerDown={resumeFollow}
            onKeyDown={resumeFollow}
            onScroll={trackScroll}
          >
            <div className="transcript" style={{ paddingBlock: 0, minHeight: "100%", justifyContent: "flex-end" }}>
              <div style={{ height: layout.size, position: "relative", flexShrink: 0 }}>
                <div
                  className="absolute top-0 left-0 w-full min-w-0"
                  style={{ transform: `translateY(${String(blockStart)}px)` }}
                >
                  <ul aria-label="Conversation" className="w-full min-w-0">
                    <TranscriptRows
                      messages={messages}
                      rows={rows}
                      expanded={expanded}
                      toggle={toggle}
                      measure={measure}
                      viewport={viewport}
                      layout={layout}
                      measurements={activityMeasurements}
                      suspended={suspended}
                    />
                  </ul>
                  <TranscriptFooter
                    count={rows.length}
                    messages={messages}
                    footerRow={footerRow}
                    blockStart={blockStart}
                    measure={measure}
                    status={status}
                  >
                    {footer}
                  </TranscriptFooter>
                </div>
              </div>
            </div>
          </MessageScrollerViewport>
          {!layout.atEnd && (
            <Button
              variant="secondary"
              size="icon-xl"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border-border bg-background"
              aria-label="Jump to latest message"
              onClick={jumpToLatest.bind(undefined, setFollow, virtualizer)}
            >
              <ArrowDownIcon />
            </Button>
          )}
        </MessageScroller>
      </div>
    </MessageScrollerProvider>
  );
}

/**
Own the standard message-scroller viewport for canonical virtualized turn rows.
@param props - Canonical turns, pending controls and covered-parent suspension state.
@returns The existing transcript provider and viewport.
*/
export function VirtualizedTranscript({
  storageKey,
  turns,
  children,
  status,
  suspended = false,
  ready = true,
}: {
  storageKey?: string;
  turns: TranscriptTurn[];
  children: ReactNode;
  status?: ReactNode;
  suspended?: boolean;
  ready?: boolean;
}) {
  const [bookmark] = useReducer(retainBookmark, storageKey, readTranscriptBookmark);
  const [expanded, toggle] = useReducer(toggledTranscriptActivity, bookmark, expandedActivities);
  const rows = rowsForTurns(turns);

  return (
    <MeasuredTranscript
      ready={ready}
      bookmark={bookmark}
      storageKey={storageKey}
      rows={rows}
      footer={Children.toArray(children)}
      status={status}
      expanded={expanded}
      suspended={suspended}
      toggle={toggle}
    />
  );
}
