import { type Range, type Virtualizer, measureElement } from "@tanstack/react-virtual";
import type { TurnEntry } from "./turn-messages";
import { string } from "./protocol";

export interface ScrollSnapshot {
  offset: number;
  extent: number;
}
export interface TranscriptTurn {
  id: string;
  entries: TurnEntry[];
}
export interface TranscriptRow {
  id: string;
  turnId: string;
  entry: TurnEntry;
}

export function rowsForTurns(turns: TranscriptTurn[]): TranscriptRow[] {
  return turns.flatMap((turn) =>
    turn.entries.map((entry) => ({
      id: entry.kind === "message" ? `${turn.id}/${string(entry.item.clientId) || entry.item.id}` : entry.id,
      turnId: turn.id,
      entry,
    }))
  );
}

export const INITIAL_MESSAGE_WINDOW = 150;
export const FORWARD_MESSAGES = 50;
export const ESTIMATED_MESSAGE_HEIGHT = 180;
const END_THRESHOLD = 8;

export function isAtTranscriptEnd(instance: Virtualizer<HTMLDivElement, HTMLElement> | undefined) {
  if (!instance?.scrollElement) {
    return false;
  }

  const element = instance.scrollElement;

  return (
    Math.abs(Math.max(instance.getTotalSize() - element.clientHeight, 0) - element.scrollTop) <= END_THRESHOLD &&
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= END_THRESHOLD
  );
}

export function bufferedMessages(range: Range, backwards = INITIAL_MESSAGE_WINDOW) {
  const start = Math.max(0, range.startIndex - backwards);
  const ahead = range.count <= INITIAL_MESSAGE_WINDOW ? INITIAL_MESSAGE_WINDOW : FORWARD_MESSAGES;
  const end = Math.min(range.count - 1, range.endIndex + ahead);

  return Array.from({ length: Math.max(end - start + 1, 0) }, (_, index) => start + index);
}

export function measureTranscriptRow(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLDivElement, HTMLElement>
) {
  // WebKit can deliver a hidden layout's queued zero after it is visible.
  // Read the current box in that case; an actually empty footer stays zero.
  return instance.options.useCachedMeasurements
    ? measureElement(element, entry, instance)
    : entry?.borderBoxSize[0]?.blockSize || element.getBoundingClientRect().height;
}

// A mounted contiguous tail can animate without crossing an unrendered window.
// Expanded activity lists must also have their whole nested path mounted.
export function needsTranscriptSeek(instance: Virtualizer<HTMLDivElement, HTMLElement>, canvas?: HTMLElement) {
  const viewport = instance.scrollElement;

  if (
    !viewport ||
    Math.abs(Math.max(instance.getTotalSize() - viewport.clientHeight, 0) - viewport.scrollTop) <=
      viewport.clientHeight * 2
  ) {
    return false;
  }

  const tail = instance.options.count - 2;
  const mounted = tail < 0 || instance.getVirtualItems().some((item) => item.index === tail);

  if (!mounted || !canvas) {
    return true;
  }

  return [...canvas.querySelectorAll("[data-activity-virtualizer]")].some((panel) => {
    const rows = panel.querySelectorAll(":scope > ul > li");

    return rows.length === 0 || rows.length < Number(rows[0].getAttribute("aria-setsize"));
  });
}

export function messageRange(range: Range, backwards: number) {
  const footerIndex = range.count - 1;

  // Keep interactive pending requests mounted while message rows are recycled.
  return [...bufferedMessages({ ...range, count: footerIndex }, backwards), footerIndex];
}
