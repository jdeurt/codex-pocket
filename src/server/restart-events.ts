import { type RestartEvent, type Snapshot, restartEventSchema } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { resumedRestart, isParentRestart } from "../state/restarts";
import { z } from "zod";

const STORE = "restart-events.json";

/** Persist a restart boundary after actual process resume hydrates visible history.
@param state - Hydrated parent snapshot at the real resume boundary.
@returns Saved restart events scoped to this parent.
*/
export async function recordRestart(state: Snapshot): Promise<RestartEvent[]> {
  const file = state.threadId ? `restarts/${encodeURIComponent(state.threadId)}.json` : STORE;
  const legacy = z
    .array(restartEventSchema)
    .parse(await readLocal(STORE, []))
    .filter(isParentRestart.bind(undefined, state.threadId));
  const saved = z.array(restartEventSchema).parse(await readLocal(file, legacy));
  const restart = resumedRestart(state, `pocket-restart:${crypto.randomUUID()}`);
  const next = restart ? [...saved, restart] : saved;

  if (restart) {
    await writeLocal(file, next);
  }

  return next.filter(isParentRestart.bind(undefined, state.threadId));
}
