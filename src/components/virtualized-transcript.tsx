"use client";

import { Children, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Item, object, string } from "@/lib/protocol";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { type Range, useVirtualizer } from "@tanstack/react-virtual";
import { Trace, TraceCollapsible, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/components/ui/trace";
import { ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "./chat-message";
import type { TurnEntry } from "@/lib/turn-messages";

const INITIAL_MESSAGE_WINDOW = 150;
const FORWARD_MESSAGES = 50;
const ESTIMATED_MESSAGE_HEIGHT = 180;
const BOTTOM_THRESHOLD = 8;
const PADDING_START = 24;
const PADDING_END = 32;
const LAST_ITEM = -1;

interface TranscriptTurn {
  id: string;
  entries: TurnEntry[];
}
interface Row {
  id: string;
  entry: TurnEntry;
}

function messageRange(range: Range) {
  const footerIndex = range.count - 1;
  const start = Math.max(0, range.startIndex - INITIAL_MESSAGE_WINDOW);
  const ahead = footerIndex <= INITIAL_MESSAGE_WINDOW ? INITIAL_MESSAGE_WINDOW : FORWARD_MESSAGES;
  const end = Math.min(footerIndex - 1, range.endIndex + ahead);

  // Keep interactive pending requests mounted while message rows are recycled.
  return [...Array.from({ length: end - start + 1 }, (_, index) => start + index), footerIndex];
}

function measureRow(element: HTMLElement, entry: ResizeObserverEntry | undefined) {
  // Preserve fractional line heights instead of accumulating rounded row sizes.
  return entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;
}

function hasVisibleContent(item: Item) {
  // Empty streaming placeholders must not create an invisible row before status.
  if (
    (Array.isArray(item.attachments) && item.attachments.length > 0) ||
    (Array.isArray(item.images) && item.images.length > 0)
  ) {
    return true;
  }

  return item.type === "agentMessage"
    ? string(item.text).trim().length > 0
    : Array.isArray(item.content) && item.content.some((part) => string(object(part).text).trim().length > 0);
}

function EmptyTranscript({ children }: { children: ReactNode }) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <div className="min-h-0 flex-1">
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="transcript" style={{ gap: "var(--message-block-gap)" }}>
              {children}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            aria-label="Jump to latest message"
            size="icon-xl"
            className="rounded-full"
            behavior="auto"
          />
        </MessageScroller>
      </div>
    </MessageScrollerProvider>
  );
}

function rowsForTurns(turns: TranscriptTurn[], expanded: Set<string>): Row[] {
  return turns.flatMap((turn) =>
    turn.entries.flatMap<Row>((entry) => {
      if (entry.kind === "message") {
        return hasVisibleContent(entry.item)
          ? { id: `${turn.id}/${string(entry.item.clientId) || entry.item.id}`, entry }
          : [];
      }

      const items = entry.items.filter((item) => hasVisibleContent(item));

      if (items.length === 0) {
        return [];
      }

      const header = { id: entry.id, entry: { ...entry, items } };

      return expanded.has(entry.id)
        ? [
            header,
            ...items.map((item) => ({
              id: `${turn.id}/${string(item.clientId) || item.id}`,
              entry: { kind: "message" as const, item },
            })),
          ]
        : header;
    })
  );
}

function MeasuredTranscript({
  rows,
  footer,
  expanded,
  toggle,
}: {
  rows: Row[];
  footer: ReactNode[];
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  // TanStack exposes a mutable controller that React Compiler must not memoize.
  "use no memo";

  const viewport = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [paused, setPaused] = useState(false);
  // Its virtual key identifies appended output; the footer DOM stays mounted
  // independently so pending answer fields retain their local draft state.
  const footerKey = `footer:${rows.at(LAST_ITEM)?.id ?? "empty"}`;
  const getItemKey = useCallback(
    (index: number) => (index === rows.length ? footerKey : rows[index].id),
    [rows, footerKey]
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- Mutable controller; this adapter opts out above.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: rows.length + 1,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: (index) => (index === rows.length ? 0 : ESTIMATED_MESSAGE_HEIGHT),
    initialOffset: () => rows.length * ESTIMATED_MESSAGE_HEIGHT,
    anchorTo: "end",
    followOnAppend: !paused,
    scrollEndThreshold: BOTTOM_THRESHOLD,
    paddingStart: PADDING_START,
    paddingEnd: PADDING_END,
    rangeExtractor: messageRange,
    measureElement: measureRow,
    onChange: (instance, sync) => {
      const end = instance.isAtEnd();
      setAtEnd(end);

      if (sync && end) {
        setPaused(false);
      }
    },
  });

  useLayoutEffect(() => {
    // The library defers iOS corrections while a finger or momentum owns the
    // scroller, then applies the measured delta after the gesture settles.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      item.end <= (instance.scrollOffset ?? 0);
    virtualizer.scrollToEnd({ behavior: "auto" });

    return () => virtualizer.cancelScroll();
  }, [virtualizer]);

  const items = virtualizer.getVirtualItems();
  const messages = items.filter((item) => item.index < rows.length);
  const footerRow = items.at(LAST_ITEM);

  return (
    <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
      <div className="min-h-0 flex-1">
        <MessageScroller>
          <MessageScrollerViewport
            ref={viewport}
            preserveScrollOnPrepend={false}
            style={{ overflowAnchor: "none" }}
            onWheel={() => virtualizer.cancelScroll()}
            onTouchStart={() => virtualizer.cancelScroll()}
            onPointerDown={() => virtualizer.cancelScroll()}
            onKeyDown={() => virtualizer.cancelScroll()}
          >
            <div className="transcript" style={{ paddingBlock: 0 }}>
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                <ul
                  aria-label="Conversation"
                  className="absolute top-0 left-0 w-full min-w-0"
                  style={{ transform: `translateY(${messages[0]?.start ?? 0}px)` }}
                >
                  {messages.map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    const next = rows[virtualRow.index + 1];

                    return (
                      <li
                        key={virtualRow.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualRow.index}
                        data-slot="message-scroller-item"
                        data-transcript-row={row.id}
                        aria-posinset={virtualRow.index + 1}
                        aria-setsize={rows.length}
                        className="min-w-0"
                        style={{ paddingBottom: next ? "var(--message-block-gap)" : 0 }}
                      >
                        {row.entry.kind === "message" ? (
                          <ChatMessage item={row.entry.item} />
                        ) : (
                          <Trace>
                            <TraceCollapsible
                              open={expanded.has(row.id)}
                              onOpenChange={() => {
                                virtualizer.cancelScroll();
                                setPaused(true);
                                toggle(row.id);
                              }}
                            >
                              <TraceCollapsibleTrigger className="min-h-11" variant="activity">
                                <TraceLine size="md" variant="activity">
                                  <TraceTitle>{expanded.has(row.id) ? "Hide activity" : "Show activity"}</TraceTitle>
                                </TraceLine>
                              </TraceCollapsibleTrigger>
                            </TraceCollapsible>
                          </Trace>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div
                  ref={(element) => virtualizer.measureElement(element)}
                  data-index={rows.length}
                  data-slot="transcript-footer"
                  className="absolute top-0 left-0 flex w-full min-w-0 flex-col [&:has(>:not(:empty))]:gap-(--message-block-gap) [&:has(>:not(:empty))]:pt-(--message-block-gap) [&>:empty]:hidden"
                  style={{
                    transform: `translateY(${footerRow?.start ?? 0}px)`,
                  }}
                >
                  {footer}
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
                setPaused(false);
                virtualizer.scrollToEnd({ behavior: "auto" });
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

// Shared by parent and read-only conversations. Network and child lifecycle stay
// with the caller; virtualization limits DOM work, not the transcript payload.
export function VirtualizedTranscript({ turns, children }: { turns: TranscriptTurn[]; children: ReactNode }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => rowsForTurns(turns, expanded), [turns, expanded]);
  const footer = Children.toArray(children);

  if (rows.length === 0) {
    return <EmptyTranscript>{children}</EmptyTranscript>;
  }

  return (
    <MeasuredTranscript
      rows={rows}
      footer={footer}
      expanded={expanded}
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
