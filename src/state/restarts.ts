import { type Item, type RestartEvent, type Snapshot, type Turn, hasTurnItems } from "../lib/protocol";

const LAST_ITEM = -1;

/** Select one parent's saved restart event.
@param threadId - Explicit parent identity.
@param event - Persisted restart event.
@returns Whether the event belongs to this parent.
*/
export function isParentRestart(threadId: string | undefined, event: RestartEvent) {
  return event.threadId === threadId;
}

/** Describe a real hydrated restart without generating identities or writing storage.
@param state - Hydrated canonical parent state.
@param id - Runtime-generated event identity.
@param afterItemId - Latest combined transcript identity when available.
@returns Restart boundary when usable history is present.
*/
export function resumedRestart(state: Snapshot, id: string, afterItemId?: string | null): RestartEvent | undefined {
  const turn = state.turns.findLast(hasTurnItems);
  const item = turn?.items.at(LAST_ITEM);

  if (turn && item && state.threadId) {
    return {
      id,
      threadId: state.threadId,
      after: { turnId: turn.id, itemId: item.id },
      ...(afterItemId !== undefined && { afterItemId }),
    };
  }
}

/** Insert stable notices after exact persisted native boundaries without mutating history.
@param state - Canonical turns and explicitly persisted restart boundaries.
@returns Detached display turns in native item order.
*/
export function projectRestarts(state: Snapshot): Turn[] {
  const boundaries = new Map<string, Map<string, RestartEvent[]>>();
  const events = state.restartEvents ?? [];

  for (const event of events) {
    if (!isParentRestart(state.threadId, event)) {
      continue;
    }

    const items = boundaries.get(event.after.turnId) ?? new Map<string, RestartEvent[]>();

    items.set(event.after.itemId, [...(items.get(event.after.itemId) ?? []), event]);
    boundaries.set(event.after.turnId, items);
  }

  const turns: Turn[] = [];

  for (const turn of state.turns) {
    const items: Item[] = [];

    for (const item of turn.items) {
      items.push(item);
      const notices = boundaries.get(turn.id)?.get(item.id) ?? [];

      for (const event of notices) {
        items.push({
          id: event.id,
          type: "pocketRestart",
          ...(event.afterItemId !== undefined && { afterItemId: event.afterItemId }),
        });
      }
    }

    turns.push({ ...turn, items });
  }

  return turns;
}
