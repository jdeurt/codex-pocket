"use client";

import { type ActivityMeasurements, VirtualizedActivity } from "./virtualized-activity";
import { Children, type ReactNode, useCallback, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ESTIMATED_MESSAGE_HEIGHT,
  FORWARD_MESSAGES,
  INITIAL_MESSAGE_WINDOW,
  type TranscriptRow as Row,
  type TranscriptTurn,
  bufferedMessages,
  isAtTranscriptEnd,
  measureTranscriptRow,
  rowsForTurns,
} from "@/lib/transcript-virtualization";
import { MessageScroller, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { type Range, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "./chat-message";
import { TranscriptScrollMotion } from "@/lib/transcript-scroll-motion";
import { TranscriptSnapshot } from "./transcript-snapshot";
import { TranscriptSuspension } from "@/lib/transcript-suspension";
import { string } from "@/lib/protocol";
import { useTranscriptMeasurements } from "@/hooks/use-transcript-measurements";

const PADDING_START = 24;
const PADDING_END = 32;
const LAST_ITEM = -1;
const ACTIVITY_LOOKAHEAD_VIEWPORTS = 3;

function isActivityTrigger(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('[data-slot="trace-collapsible-trigger"]');
}

function messageRange(range: Range, backwards: number) {
  const footerIndex = range.count - 1;

  // Keep interactive pending requests mounted while message rows are recycled.
  return [...bufferedMessages({ ...range, count: footerIndex }, backwards), footerIndex];
}

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
  // TanStack exposes a mutable controller that React Compiler must not memoize.
  "use no memo";

  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [motion] = useState(() => new TranscriptScrollMotion());
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [suspension] = useState(() => new TranscriptSuspension(redraw));
  const paused = suspended || suspension.blocked;
  const [activityMeasurements] = useState<ActivityMeasurements>(() => new Map());
  const [atEnd, setAtEnd] = useState(true);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const nested = rows
        .slice(Math.max(range.startIndex - 1, 0), range.endIndex + 1)
        .some(
          (row) => row.entry.kind === "activity" && expanded.has(row.id) && row.entry.items.length > FORWARD_MESSAGES
        );

      // A large visible panel supplies its own message buffer. Avoid counting
      // both its inner history window and a full outer history window.
      return messageRange(range, nested ? FORWARD_MESSAGES : INITIAL_MESSAGE_WINDOW);
    },
    [rows, expanded]
  );
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
    anchorTo: paused ? "start" : "end",
    // One follow owner: the motion adapter. Library anchoring remains enabled.
    followOnAppend: false,
    scrollEndThreshold: -1,
    paddingStart: PADDING_START,
    paddingEnd: PADDING_END,
    rangeExtractor,
    // The custom range owns the DOM budget. Keep every mounted row eligible
    // for core measurement while a smooth end command crosses older history.
    overscan: rows.length + 1,
    measureElement: measureTranscriptRow,
    useCachedMeasurements: suspended,
    scrollToFn: (offset, options, instance) =>
      suspension.scrollTo(offset, options, instance, suspended, () => motion.scrollTo(offset, options, instance)),
    onChange: (instance, sync) => {
      const end = isAtTranscriptEnd(instance);
      setAtEnd(end);
      suspension.readPosition(instance, suspended);
      motion.readPosition(instance, sync);
    },
  });

  useTranscriptMeasurements(
    virtualizer,
    suspension,
    canvas,
    ':scope > div > ul > li, :scope > div > [data-slot="transcript-footer"]'
  );

  useLayoutEffect(() => {
    // The library defers iOS corrections while a finger or momentum owns the
    // scroller, then applies the measured delta after the gesture settles.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      !suspension.blocked && item.end <= (instance.scrollOffset ?? 0);

    if (canvas.current) {
      motion.mount(virtualizer, canvas.current);
    }

    return () => {
      motion.unmount();
      suspension.unmount();
    };
  }, [virtualizer, motion, suspension]);

  const last = rows.at(LAST_ITEM);
  useLayoutEffect(() => {
    suspension.update(suspended, virtualizer, (value) => motion.suspend(value));

    if (last?.entry.kind === "message" && last.entry.item.type === "agentMessage") {
      motion.source(last.id, string(last.entry.item.text));
    }

    motion.layout();
  });

  const items = virtualizer.getVirtualItems();
  const messages = items.filter((item) => item.index < rows.length);
  const footerRow = items.at(LAST_ITEM);
  const blockStart = messages[0]?.start ?? footerRow?.start ?? 0;
  const includesTail = rows.length === 0 || messages.at(LAST_ITEM)?.index === rows.length - 1;

  const pointerIntent = (event: { target: EventTarget | null }) => {
    suspension.finish((value) => motion.suspend(value));
    const target = event.target;

    if (isActivityTrigger(target)) {
      return;
    }

    if (target instanceof Element && target.closest('button, a, input, textarea, [role="button"]')) {
      motion.control();
    } else {
      motion.interrupt();
    }
  };

  return (
    <TranscriptSnapshot
      suspended={suspended}
      capture={() => suspension.capture(virtualizer)}
      retain={(value) => suspension.retain(value)}
    >
      <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
        <div className="min-h-0 flex-1">
          <MessageScroller>
            <MessageScrollerViewport
              ref={viewport}
              data-scroll-suspended={paused || undefined}
              preserveScrollOnPrepend={false}
              style={suspension.viewportStyle(suspended)}
              onWheel={() => {
                suspension.finish((value) => motion.suspend(value));
                motion.interrupt();
              }}
              onTouchStart={pointerIntent}
              onTouchMove={() => motion.interrupt()}
              onPointerDown={pointerIntent}
              onKeyDown={(event) => {
                suspension.finish((value) => motion.suspend(value));

                if (!((event.key === "Enter" || event.key === " ") && isActivityTrigger(event.target))) {
                  motion.interrupt();
                }
              }}
            >
              <div className="transcript" style={{ paddingBlock: 0 }}>
                <div
                  ref={canvas}
                  style={{
                    height: virtualizer.getTotalSize(),
                    minHeight: Math.max(
                      motion.size(virtualizer.getTotalSize()),
                      suspension.size(
                        virtualizer.getTotalSize(),
                        suspended,
                        virtualizer.scrollRect?.height ?? 0,
                        virtualizer.scrollElement
                      )
                    ),
                    position: "relative",
                  }}
                >
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
                            ref={virtualizer.measureElement}
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
                                onOpenChange={() => {
                                  motion.disclose(isAtTranscriptEnd(virtualizer));
                                  toggle(row.id);
                                }}
                                onSettled={() => motion.disclosed()}
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
                                suspension={suspension}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <div
                      ref={(element) => virtualizer.measureElement(element)}
                      data-index={rows.length}
                      data-slot="transcript-footer"
                      data-has-messages={rows.length > 0 || undefined}
                      className="message-flow absolute top-0 left-0 w-full min-w-0 [&[data-has-messages]:has(>:not(:empty))]:pt-(--message-block-gap) [&>:empty]:hidden"
                      style={{
                        gap: footer.length === 0 ? 0 : undefined,
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
                  suspension.finish((value) => motion.suspend(value));
                  motion.latest();
                }}
              >
                <ArrowDownIcon />
              </Button>
            )}
          </MessageScroller>
        </div>
      </MessageScrollerProvider>
    </TranscriptSnapshot>
  );
}

// Shared by parent and read-only conversations. Network and child lifecycle stay
// with the caller; virtualization limits DOM work, not the transcript payload.
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
  const footer = Children.toArray(children);

  return (
    <MeasuredTranscript
      rows={rows}
      footer={footer}
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
