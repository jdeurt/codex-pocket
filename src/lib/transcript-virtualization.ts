import type { Range } from "@tanstack/react-virtual";

export const INITIAL_MESSAGE_WINDOW = 150;
export const FORWARD_MESSAGES = 50;
export const ESTIMATED_MESSAGE_HEIGHT = 180;

export function bufferedMessages(range: Range, backwards = INITIAL_MESSAGE_WINDOW) {
  const start = Math.max(0, range.startIndex - backwards);
  const ahead = range.count <= INITIAL_MESSAGE_WINDOW ? INITIAL_MESSAGE_WINDOW : FORWARD_MESSAGES;
  const end = Math.min(range.count - 1, range.endIndex + ahead);

  return Array.from({ length: Math.max(end - start + 1, 0) }, (_, index) => start + index);
}

export function measureTranscriptRow(element: HTMLElement, entry: ResizeObserverEntry | undefined) {
  return entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;
}
