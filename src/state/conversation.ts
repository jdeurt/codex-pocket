import { type Snapshot, type Item } from "../lib/protocol";
import { turnMessages } from "../lib/turn-messages";
import { type TranscriptTurn } from "../lib/transcript-virtualization";

/** Project native items according to explicit display preferences.
@param items - Native turn items.
@param isReadOnly - Whether restart notices are excluded.
@param shouldShowTools - Whether tool details are visible.
@returns Immutable display items, preserving tool images when details are hidden.
*/
function displayItems(items: readonly Item[], isReadOnly: boolean, shouldShowTools: boolean) {
  const result: Item[] = [];

  for (const item of items) {
    if (isReadOnly && item.type === "pocketRestart") {
      continue;
    }

    if (!shouldShowTools && item.type === "toolTrace") {
      if (item.images?.length) {
        result.push({ ...item, type: "imageOutput" });
      }
    } else {
      result.push(item);
    }
  }

  return result;
}

/** Select renderable turns without changing the canonical conversation.
@param snapshot - Canonical native conversation.
@param isReadOnly - Whether this is a read-only agent view.
@param shouldShowTools - Whether tool details are visible.
@returns Display turns in canonical order.
*/
export function conversationTurns(snapshot: Snapshot, isReadOnly: boolean, shouldShowTools: boolean): TranscriptTurn[] {
  const result: TranscriptTurn[] = [];

  for (const turn of snapshot.turns) {
    const entries = turnMessages(
      { ...turn, items: displayItems(turn.items, isReadOnly, shouldShowTools) },
      turn.id === snapshot.activeTurnId || turn.status === "inProgress"
    );

    if (entries.length > 0) {
      result.push({ id: turn.id, entries });
    }
  }

  return result;
}

/** Select a queue identity for caption deduplication.
@param item - Queued native message.
@returns Stable delivery identity.
*/
export function queuedIdentity(item: Snapshot["queue"][number]) {
  return item.id;
}
