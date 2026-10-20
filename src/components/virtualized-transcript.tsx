"use client";
import { type ActivityMeasurements, VirtualizedActivity } from "./virtualized-activity";
import {
  Children,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  END_THRESHOLD,
  ESTIMATED_MESSAGE_HEIGHT,
  FORWARD_MESSAGES,
  INITIAL_MESSAGE_WINDOW,
  type TranscriptRow as Row,
  type TranscriptTurn,
  messageRange,
  rowsForTurns,
} from "@/lib/transcript-virtualization";
import { MessageScroller, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { type Range, type VirtualItem, elementScroll } from "@tanstack/react-virtual";
import { type TranscriptLayout, useTranscriptVirtualizer } from "@/hooks/use-transcript-virtualizer";
import { ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "./chat-message";

const PADDING_START = 24;
const PADDING_END = 32;
const LAST_ITEM = -1;
const ACTIVITY_LOOKAHEAD_VIEWPORTS = 3;

/**
Render and measure one canonical transcript row with its native virtual position.
@param props - Canonical row, TanStack measurement and the existing viewport/activity callbacks.
@returns The matching measured message or activity row.
*/
function TranscriptEntry({
  row,
  virtualRow,
  open,
  toggle,
  viewport,
  layout,
  measurements,
  suspended,
}: {
  row: Row;
  virtualRow: VirtualItem;
  open: boolean;
  toggle: () => void;
  viewport: RefObject<HTMLDivElement | null>;
  layout: TranscriptLayout;
  measurements: ActivityMeasurements;
  suspended: boolean;
}) {
  if (row.entry.kind === "message") {
    return <ChatMessage item={row.entry.item} />;
  }

  return (
    <VirtualizedActivity
      id={row.id}
      turnId={row.turnId}
      items={row.entry.items}
      open={open}
      onOpenChange={toggle}
      viewport={viewport}
      origin={virtualRow.start}
      end={virtualRow.end}
      scrollOffset={layout.offset}
      nearby={
        virtualRow.end >= layout.offset - layout.height * 2 &&
        virtualRow.start <= layout.offset + layout.height * ACTIVITY_LOOKAHEAD_VIEWPORTS
      }
      measurements={measurements}
      suspended={suspended}
    />
  );
}

/**
Keep the existing bounded range when an expanded nested activity panel is nearby.
@param rows - Canonical transcript rows owned by the outer list.
@param expanded - IDs of currently expanded activity groups.
@param range - Native TanStack range to extend.
@returns Buffered message indices with the interactive footer retained.
*/
function transcriptRange(rows: Row[], expanded: Set<string>, range: Range) {
  const isNested = rows
    .slice(Math.max(range.startIndex - 1, 0), range.endIndex + 1)
    .some((row) => row.entry.kind === "activity" && expanded.has(row.id) && row.entry.items.length > FORWARD_MESSAGES);

  return messageRange(range, isNested ? FORWARD_MESSAGES : INITIAL_MESSAGE_WINDOW);
}

/**
Keep interactive pending controls mounted at the standard transcript tail.
@param props - Message count, native visible rows, footer measurement and existing controls.
@returns The existing measured footer container.
*/
function TranscriptFooter({
  count,
  messages,
  footerRow,
  blockStart,
  measure,
  children,
}: {
  count: number;
  messages: VirtualItem[];
  footerRow?: VirtualItem;
  blockStart: number;
  measure: (element: HTMLElement | null) => void;
  children: ReactNode;
}) {
  const hasTail = count === 0 || messages.at(LAST_ITEM)?.index === count - 1;

  return (
    <div
      ref={measure}
      data-index={count}
      data-slot="transcript-footer"
      className={`message-flow w-full min-w-0 ${count > 0 ? "[&:not(:empty)]:pt-(--message-block-gap)" : ""}`}
      style={{
        position: hasTail ? "static" : "absolute",
        transform: hasTail ? undefined : `translateY(${String((footerRow?.start ?? 0) - blockStart)}px)`,
      }}
    >
      {children}
    </div>
  );
}

/**
Delegate transcript measurement, anchoring and append following to TanStack.
@param props - Canonical rows, pending controls and covered-parent suspension state.
@returns The existing measured rows and jump-to-latest control.
*/
function MeasuredTranscript({
  rows,
  footer,
  expanded,
  toggle,
  suspended,
}: {
  rows: Row[];
  footer: ReactNode[];
  expanded: Set<string>;
  toggle: (id: string) => void;
  suspended: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const savedOffset = useRef<number | undefined>(undefined);
  const [follow, setFollow] = useState(true);

  const [activityMeasurements] = useState<ActivityMeasurements>(() => new Map());
  const rangeExtractor = useCallback((range: Range) => transcriptRange(rows, expanded, range), [rows, expanded]);

  // Keep the ordinary content row mounted so pending answer drafts survive recycling.
  const footerKey = `footer:${rows.at(LAST_ITEM)?.id ?? "empty"}`;
  const getItemKey = useCallback(
    (index: number) => (index === rows.length ? footerKey : rows[index].id),
    [rows, footerKey]
  );
  const { virtualizer, layout } = useTranscriptVirtualizer({
    count: rows.length + 1,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: (index) => (index === rows.length ? 0 : ESTIMATED_MESSAGE_HEIGHT),
    initialOffset: () => rows.length * ESTIMATED_MESSAGE_HEIGHT,
    anchorTo: suspended || !follow ? "start" : "end",
    followOnAppend: !suspended && follow,
    scrollEndThreshold: END_THRESHOLD,
    paddingStart: PADDING_START,
    paddingEnd: PADDING_END,
    rangeExtractor,
    overscan: rows.length + 1,
    useCachedMeasurements: suspended,
    scrollToFn: (offset, options, instance) => {
      if (!suspended) {
        elementScroll(offset, options, instance);
      }
    },
  });
  // Reattach the documented measurement ref when cached measurements resume.
  const measure = useCallback(
    (element: HTMLElement | null) => {
      if (!suspended) {
        virtualizer.measureElement(element);
      }
    },
    [virtualizer, suspended]
  );
  const items = layout.rows;
  const messages = items.filter((item) => item.index < rows.length);
  const footerRow = items.at(LAST_ITEM);
  const blockStart = messages.at(0)?.start ?? footerRow?.start ?? 0;
  const resumeFollow = () => {
    if (!suspended) {
      setFollow(true);
    }
  };

  if (suspended && follow) {
    setFollow(false);
  }

  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);
  useLayoutEffect(() => {
    if (suspended) {
      savedOffset.current = viewport.current?.scrollTop;
      virtualizer.cancelScroll();
    } else if (savedOffset.current !== undefined) {
      virtualizer.scrollToOffset(savedOffset.current);
      savedOffset.current = undefined;
    }
  }, [suspended, virtualizer]);

  return (
    <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
      <div className="min-h-0 flex-1">
        <MessageScroller>
          <MessageScrollerViewport
            ref={viewport}
            data-scroll-suspended={suspended || undefined}
            preserveScrollOnPrepend={false}
            style={{ overflowAnchor: "none", overflowY: suspended ? "hidden" : undefined }}
            onWheel={resumeFollow}
            onTouchStart={resumeFollow}
            onPointerDown={resumeFollow}
            onKeyDown={resumeFollow}
          >
            <div className="transcript" style={{ paddingBlock: 0 }}>
              <div style={{ height: layout.size, position: "relative" }}>
                <div
                  className="absolute top-0 left-0 w-full min-w-0"
                  style={{ transform: `translateY(${String(blockStart)}px)` }}
                >
                  <ul aria-label="Conversation" className="w-full min-w-0">
                    {messages.map((virtualRow) => {
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
                            toggle={() => {
                              toggle(row.id);
                            }}
                            viewport={viewport}
                            layout={layout}
                            measurements={activityMeasurements}
                            suspended={suspended}
                          />
                        </li>
                      );
                    })}
                  </ul>
                  <TranscriptFooter
                    count={rows.length}
                    messages={messages}
                    footerRow={footerRow}
                    blockStart={blockStart}
                    measure={measure}
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
              onClick={() => {
                setFollow(true);
                virtualizer.scrollToEnd();
              }}
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
  turns,
  children,
  suspended = false,
}: {
  turns: TranscriptTurn[];
  children: ReactNode;
  suspended?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => rowsForTurns(turns), [turns]);

  return (
    <MeasuredTranscript
      rows={rows}
      footer={Children.toArray(children)}
      expanded={expanded}
      suspended={suspended}
      toggle={(id) => {
        setExpanded((previous) => {
          const next = new Set(previous);

          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }

          return next;
        });
      }}
    />
  );
}
