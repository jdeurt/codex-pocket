"use client";

import { type ActivityMeasurements, VirtualizedActivity } from "./virtualized-activity";
import { Children, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { type Range, elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "./chat-message";

const PADDING_START = 24;
const PADDING_END = 32;
const LAST_ITEM = -1;
const ACTIVITY_LOOKAHEAD_VIEWPORTS = 3;

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
  "use no memo";

  const viewport = useRef<HTMLDivElement>(null);
  const savedOffset = useRef<number | undefined>(undefined);
  const [follow, setFollow] = useState(true);
  const [activityMeasurements] = useState<ActivityMeasurements>(() => new Map());
  const [atEnd, setAtEnd] = useState(true);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const nested = rows
        .slice(Math.max(range.startIndex - 1, 0), range.endIndex + 1)
        .some(
          (row) => row.entry.kind === "activity" && expanded.has(row.id) && row.entry.items.length > FORWARD_MESSAGES
        );

      return messageRange(range, nested ? FORWARD_MESSAGES : INITIAL_MESSAGE_WINDOW);
    },
    [rows, expanded]
  );
  // Keep the ordinary content row mounted so pending answer drafts survive recycling.
  const footerKey = `footer:${rows.at(LAST_ITEM)?.id ?? "empty"}`;
  const getItemKey = useCallback(
    (index: number) => (index === rows.length ? footerKey : rows[index].id),
    [rows, footerKey]
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
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
    onChange: (instance) => setAtEnd(instance.isAtEnd()),
  });
  // Reattach the documented measurement ref when cached measurements resume.
  const measure = useCallback(
    (element: HTMLElement | null) => virtualizer.measureElement(element),
    [virtualizer, suspended]
  );
  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);
  useLayoutEffect(() => {
    if (suspended) {
      savedOffset.current = viewport.current?.scrollTop;
      virtualizer.cancelScroll();
      setFollow(false);
    } else if (savedOffset.current !== undefined) {
      virtualizer.scrollToOffset(savedOffset.current);
      savedOffset.current = undefined;
    }
  }, [suspended, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const messages = items.filter((item) => item.index < rows.length);
  const footerRow = items.at(LAST_ITEM);
  const blockStart = messages[0]?.start ?? footerRow?.start ?? 0;
  const includesTail = rows.length === 0 || messages.at(LAST_ITEM)?.index === rows.length - 1;
  const resumeFollow = () => {
    if (!suspended) {
      setFollow(true);
    }
  };

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
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                <div
                  className="absolute top-0 left-0 w-full min-w-0"
                  style={{ transform: `translateY(${blockStart}px)` }}
                >
                  <ul aria-label="Conversation" className="w-full min-w-0">
                    {messages.map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      const next = rows[virtualRow.index + 1];

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
                          {row.entry.kind === "message" ? (
                            <ChatMessage item={row.entry.item} />
                          ) : (
                            <VirtualizedActivity
                              id={row.id}
                              turnId={row.turnId}
                              items={row.entry.items}
                              open={expanded.has(row.id)}
                              onOpenChange={() => toggle(row.id)}
                              viewport={viewport}
                              origin={virtualRow.start}
                              end={virtualRow.end}
                              scrollOffset={virtualizer.scrollOffset ?? 0}
                              nearby={
                                virtualRow.end >=
                                  (virtualizer.scrollOffset ?? 0) - (virtualizer.scrollRect?.height ?? 0) * 2 &&
                                virtualRow.start <=
                                  (virtualizer.scrollOffset ?? 0) +
                                    (virtualizer.scrollRect?.height ?? 0) * ACTIVITY_LOOKAHEAD_VIEWPORTS
                              }
                              measurements={activityMeasurements}
                              suspended={suspended}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div
                    ref={measure}
                    data-index={rows.length}
                    data-slot="transcript-footer"
                    className={`message-flow w-full min-w-0 ${rows.length ? "[&:not(:empty)]:pt-(--message-block-gap)" : ""}`}
                    style={{
                      position: includesTail ? "static" : "absolute",
                      transform: includesTail ? undefined : `translateY(${(footerRow?.start ?? 0) - blockStart}px)`,
                    }}
                  >
                    {footer}
                  </div>
                </div>
              </div>
            </div>
          </MessageScrollerViewport>
          {!atEnd && (
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
