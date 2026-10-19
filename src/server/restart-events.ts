import type { RestartEvent, Snapshot, Turn } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";

const STORE = "restart-events.json";
const LAST_ITEM = -1;

export async function recordRestart(state: Snapshot): Promise<RestartEvent[]> {
  const saved = await readLocal<RestartEvent[]>(STORE, []);
  const turn = state.turns.findLast((entry) => entry.items.length > 0);
  const item = turn?.items.at(LAST_ITEM);

  // Record only a real, hydrated process resume. Never infer past restarts from history.
  if (state.threadId && turn && item) {
    saved.push({
      id: `pocket-restart:${crypto.randomUUID()}`,
      threadId: state.threadId,
      after: { turnId: turn.id, itemId: item.id },
    });
    await writeLocal(STORE, saved);
  }

  return saved.filter((event) => event.threadId === state.threadId);
}

export function projectRestarts(state: Snapshot): Turn[] {
  const boundaries = new Map<string, Map<string, RestartEvent[]>>();

  for (const event of state.restartEvents ?? []) {
    if (event.threadId !== state.threadId) {
      continue;
    }

    const items = boundaries.get(event.after.turnId) ?? new Map<string, RestartEvent[]>();
    const events = items.get(event.after.itemId) ?? [];
    events.push(event);
    items.set(event.after.itemId, events);
    boundaries.set(event.after.turnId, items);
  }

  return state.turns.map((turn) => ({
    ...turn,
    items: turn.items.flatMap((item) => [
      item,
      ...(boundaries.get(turn.id)?.get(item.id) ?? []).map((event) => ({
        id: event.id,
        type: "pocketRestart",
      })),
    ]),
  }));
}
