import { type RestartEvent, type Snapshot, type Turn, restartEventSchema } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { z } from "zod";

const STORE = "restart-events.json";
const LAST_ITEM = -1;

/**
Persist a restart boundary only after actual process resume hydrates visible history.
@param state - Hydrated parent snapshot at the real resume boundary.
@returns Saved restart events scoped to this parent.
*/
export async function recordRestart(state: Snapshot): Promise<RestartEvent[]> {
  const saved = z.array(restartEventSchema).parse(await readLocal(STORE, []));
  const turn = state.turns.findLast((entry) => entry.items.length > 0);
  const item = turn?.items.at(LAST_ITEM);

  // Record only a real, hydrated process resume. Never infer past restarts from history.
  if (turn && item && state.threadId) {
    saved.push({
      id: `pocket-restart:${crypto.randomUUID()}`,
      threadId: state.threadId,
      after: { turnId: turn.id, itemId: item.id },
    });
    await writeLocal(STORE, saved);
  }

  return saved.filter((event) => event.threadId === state.threadId);
}

/**
Group one persisted restart by its exact native turn and item boundary.
@param boundaries - Ordered restart groups used only for display projection.
@param event - Persisted restart event already scoped to this parent.
*/
function addRestart(boundaries: Map<string, Map<string, RestartEvent[]>>, event: RestartEvent) {
  const items = boundaries.get(event.after.turnId) ?? new Map<string, RestartEvent[]>();
  const events = items.get(event.after.itemId) ?? [];

  events.push(event);
  items.set(event.after.itemId, events);
  boundaries.set(event.after.turnId, items);
}

/**
Insert stable display notices after recorded native restart boundaries.
@param state - Snapshot containing native turns and persisted restart events.
@returns Turns preserving native item order and synthetic restart identities.
*/
export function projectRestarts(state: Snapshot): Turn[] {
  const boundaries = new Map<string, Map<string, RestartEvent[]>>();
  const restartEvents = state.restartEvents ?? [];

  for (const event of restartEvents) {
    if (event.threadId !== state.threadId) {
      continue;
    }

    addRestart(boundaries, event);
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
