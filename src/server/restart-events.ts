import { type RestartEvent, type Snapshot, restartEventSchema } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { resumedRestart, isParentRestart } from "../state/restarts";
import { z } from "zod";
import { t } from "try";
import { log } from "./logging";
import { VoiceHistory } from "./voice-history";
import { lastTimelineItem } from "../state/voice-context";

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

  if (!resumedRestart(state, "")) {
    return saved.filter(isParentRestart.bind(undefined, state.threadId));
  }

  const voice = new VoiceHistory(state.threadId ?? "");
  const restored = await t(voice.read.bind(voice));

  if (!restored.ok) {
    log().error({ error: restored.error }, "restart.voice_history_unavailable");
  }

  const history = restored.ok ? restored.value : [];
  const snapshot = { ...state, restartEvents: saved };
  const restart = resumedRestart(
    snapshot,
    `pocket-restart:${crypto.randomUUID()}`,
    lastTimelineItem(snapshot, history)
  );
  const next = restart ? [...saved, restart] : saved;

  if (restart) {
    await writeLocal(file, next);
  }

  return next.filter(isParentRestart.bind(undefined, state.threadId));
}
