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

  return Array.from({ length: Math.max(end - start + 1, 0) }, (_, index) => start + index);
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
