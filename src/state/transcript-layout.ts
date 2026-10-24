import { type VirtualItem } from "@tanstack/react-virtual";

export interface TranscriptLayout {
  rows: VirtualItem[];
  size: number;
  offset: number;
  height: number;
  atEnd: boolean;
}

/** Create an empty layout before the runtime owns native measurements.
@returns Deterministic initial transcript geometry.
*/
export function initialTranscriptLayout(): TranscriptLayout {
  return { rows: [], size: 0, offset: 0, height: 0, atEnd: true };
}

/** Detach one native row so later measurement cannot mutate a rendered snapshot.
@param row - Current native virtual item.
@returns An independent row value.
*/
export function copiedVirtualItem(row: VirtualItem): VirtualItem {
  return { ...row };
}

/** Compare layout values without relying on mutable native row identity.
@param previous - Published layout.
@param next - Candidate detached layout.
@returns Whether React can retain the current snapshot.
*/
export function hasSameLayout(previous: TranscriptLayout, next: TranscriptLayout) {
  if (
    previous.size !== next.size ||
    previous.offset !== next.offset ||
    previous.height !== next.height ||
    previous.atEnd !== next.atEnd ||
    previous.rows.length !== next.rows.length
  ) {
    return false;
  }

  for (const [index, row] of previous.rows.entries()) {
    const other = next.rows[index];

    if (
      row.key !== other.key ||
      row.index !== other.index ||
      row.start !== other.start ||
      row.end !== other.end ||
      row.size !== other.size ||
      row.lane !== other.lane
    ) {
      return false;
    }
  }

  return true;
}

/** Decide viewport following from the geometry before a native resize is adopted.
@param geometry - Explicit native anchoring, scale and measured geometry.
@returns Whether the runtime should retain the end position after resizing.
*/
export function shouldFollowViewport(geometry: {
  anchorTo: "start" | "end";
  followOnAppend: boolean;
  previousHeight?: number;
  nextHeight: number;
  size: number;
  offset: number;
  threshold: number;
  scale: number;
}) {
  return (
    geometry.anchorTo === "end" &&
    geometry.followOnAppend &&
    geometry.previousHeight !== undefined &&
    geometry.previousHeight > 0 &&
    geometry.previousHeight !== geometry.nextHeight &&
    Math.max(geometry.size - geometry.previousHeight - geometry.offset, 0) <= geometry.threshold &&
    geometry.scale === 1
  );
}

/** Select the first saved row crossing the restored scroll position.
@param measurements - Saved native measurement cache.
@param offset - Explicit restored offset.
@returns Matching row, when one exists.
*/
export function restoredAnchor(measurements: VirtualItem[] | undefined, offset: number) {
  const rows = measurements ?? [];

  for (const item of rows) {
    if (item.end > offset) {
      return item;
    }
  }
}

/** Keep only preceding measurements eligible to adjust a restored anchor.
@param anchor - Saved row being restored.
@param item - Native item whose size changed.
@returns Whether its change occurs above the restored row.
*/
export function shouldAdjustRestoredAnchor(anchor: VirtualItem, item: VirtualItem) {
  return item.index < anchor.index;
}

/** Select measured message rows while excluding the interactive footer.
@param rows - Current native virtual rows.
@param messageCount - Canonical message count.
@returns Message measurements in native order.
*/
export function measuredMessages(rows: VirtualItem[], messageCount: number) {
  const messages: VirtualItem[] = [];

  for (const row of rows) {
    if (row.index < messageCount) {
      messages.push(row);
    }
  }

  return messages;
}

/** Decide whether an inner measurement owns the reader's visible anchor.
@param isSuspended - Whether the outer view is covered.
@param margin - Nested panel's origin.
@param itemEnd - End of the changed nested item.
@param offset - Current parent scroll offset.
@param totalSize - Native nested content size.
@returns Whether to adjust within the panel instead of deferring to the outer list.
*/
export function shouldAdjustActivity(
  isSuspended: boolean,
  margin: number,
  itemEnd: number,
  offset: number,
  totalSize: number
) {
  return !isSuspended && offset < margin + totalSize && itemEnd <= offset;
}
