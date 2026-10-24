import type { Range } from "@tanstack/react-virtual";
import type { TurnEntry } from "./turn-messages";
import { string } from "./protocol";

export interface TranscriptTurn {
  id: string;
  entries: TurnEntry[];
}
export interface TranscriptRow {
  id: string;
  turnId: string;
  entry: TurnEntry;
}

/**
Flatten canonical turn entries while keeping stable row IDs through delivery reconciliation.
@param turns - Turns with parser-filtered message and activity entries.
@returns Rows that retain their owning turn and entry.
*/
export function rowsForTurns(turns: TranscriptTurn[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];

  for (const turn of turns) {
    for (const entry of turn.entries) {
      rows.push({
        id: entry.kind === "message" ? `${turn.id}/${string(entry.item.clientId) || entry.item.id}` : entry.id,
        turnId: turn.id,
        entry,
      });
    }
  }

  return rows;
}

export const INITIAL_MESSAGE_WINDOW = 150;
export const FORWARD_MESSAGES = 50;
export const ESTIMATED_MESSAGE_HEIGHT = 180;
export const END_THRESHOLD = 8;

/**
Extend TanStack's visible range with the existing bounded message buffers.
@param range - Native virtualizer range before the interactive footer.
@param [backwards] - Number of prior messages to retain, defaulting to the initial window.
@returns Ordered in-bounds message indices to mount.
*/
export function bufferedMessages(range: Range, backwards = INITIAL_MESSAGE_WINDOW) {
  const start = Math.max(0, range.startIndex - backwards);
  const ahead = range.count <= INITIAL_MESSAGE_WINDOW ? INITIAL_MESSAGE_WINDOW : FORWARD_MESSAGES;
  const end = Math.min(range.count - 1, range.endIndex + ahead);

  const indices: number[] = [];

  for (let index = start; index <= end; index++) {
    indices.push(index);
  }

  return indices;
}

/**
Keep the interactive footer mounted alongside buffered transcript messages.
@param range - Native range whose final item is the footer.
@param backwards - Number of preceding messages to retain.
@returns Buffered message indices followed by the footer index.
*/
export function messageRange(range: Range, backwards: number) {
  const footerIndex = range.count - 1;

  // Keep interactive pending requests mounted while message rows are recycled.
  return [...bufferedMessages({ ...range, count: footerIndex }, backwards), footerIndex];
}

/** Retain a smaller outer buffer when nearby expanded activity owns a nested virtualizer.
@param rows - Canonical outer rows.
@param expanded - Open activity identities.
@param range - Native visible range.
@returns Buffered message indices including the interactive footer.
*/
export function transcriptRange(rows: TranscriptRow[], expanded: Set<string>, range: Range) {
  const nearby = rows.slice(Math.max(range.startIndex - 1, 0), range.endIndex + 1);

  for (const row of nearby) {
    if (row.entry.kind === "activity" && expanded.has(row.id) && row.entry.items.length > FORWARD_MESSAGES) {
      return messageRange(range, FORWARD_MESSAGES);
    }
  }

  return messageRange(range, INITIAL_MESSAGE_WINDOW);
}

/** Read a stable native key for a message or the always-mounted footer.
@param rows - Canonical outer rows.
@param index - Native requested row index.
@returns Stable message or footer identity.
*/
export function transcriptRowKey(rows: TranscriptRow[], index: number) {
  return index === rows.length ? "transcript-footer" : rows[index].id;
}

/** Estimate only message rows before native measurement.
@param count - Number of message rows preceding the footer.
@param index - Requested row index.
@returns Message estimate or zero for the separately measured footer.
*/
export function estimatedTranscriptRow(count: number, index: number) {
  return index === count ? 0 : ESTIMATED_MESSAGE_HEIGHT;
}

/** Toggle a disclosure without changing the previous expanded set.
@param previous - Current expanded identities.
@param id - Explicitly requested disclosure.
@returns New expansion state.
*/
export function toggledTranscriptActivity(previous: Set<string>, id: string) {
  const next = new Set(previous);

  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }

  return next;
}

/** Extend the nested range only while its panel is near the viewport.
@param isNearby - Whether the outer list considers this panel visible or buffered.
@param range - Native nested visible range.
@returns Bounded indices or no mounted inner messages.
*/
export function activityRange(isNearby: boolean, range: Range) {
  return isNearby ? bufferedMessages(range) : [];
}
