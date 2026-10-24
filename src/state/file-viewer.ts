import { z } from "zod";

export const fileMetadataSchema = z.object({
  filename: z.string(),
  name: z.string(),
  type: z.string(),
  markdown: z.string().nullable(),
});

export type FileMetadata = z.infer<typeof fileMetadataSchema>;
export interface FileViewState {
  file: FileMetadata | null;
  error: string;
  offset: number;
}
export interface FilePointer {
  x: number;
  y: number;
}
export const FILE_EDGE_WIDTH = 32;
const SWIPE_DIVISOR = 3;

/** Create deterministic file-view data without fetching or inspecting the browser.
@returns Initial loading projection.
*/
export function initialFileView(): FileViewState {
  return { file: null, error: "", offset: 0 };
}

/** Decide whether an edge gesture remains horizontal and how far it has moved.
@param start - Pointer coordinates when the gesture began.
@param current - Latest pointer coordinates.
@returns Next offset and cancellation decision.
*/
export function movedFileGesture(start: FilePointer, current: FilePointer) {
  const x = current.x - start.x;
  const isCancelled = Math.abs(current.y - start.y) > Math.max(FILE_EDGE_WIDTH, x);

  return { isCancelled, offset: isCancelled ? 0 : Math.max(0, x), shouldCapture: !isCancelled && x > FILE_EDGE_WIDTH };
}

/** Decide back navigation from explicit gesture distance and viewport width.
@param offset - Current horizontal drag distance.
@param width - Runtime-observed viewport width.
@returns Whether releasing the gesture should navigate back.
*/
export function isFileSwipeComplete(offset: number, width: number) {
  return offset >= width / SWIPE_DIVISOR;
}
