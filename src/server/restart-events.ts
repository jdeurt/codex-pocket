import { type RestartEvent, type Snapshot, restartEventSchema } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { resumedRestart, isParentRestart } from "../state/restarts";
import { z } from "zod";
import { t } from "try";
import { log } from "./logging";
import { type Bridge } from "./bridge-session";
import { VoiceHistory } from "./voice-history";
import { type VoiceSegment } from "../lib/voice-history";
import { reconcileCaptions } from "../state/voice";
import { lastTimelineItem } from "../state/voice-context";

const STORE = "restart-events.json";

/** Persist a restart boundary after actual process resume hydrates visible history.
@param state - Hydrated parent snapshot at the real resume boundary.
@param id - Runtime-reserved restart identity.
@param live - Immutable fragments observed before persistence began.
@returns Saved restart events scoped to this parent.
*/
export async function recordRestart(state: Snapshot, id: string, live: VoiceSegment[]): Promise<RestartEvent[]> {
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

  const history = reconcileCaptions(restored.ok ? restored.value : [], live);
  const snapshot = { ...state, restartEvents: saved };
  const restart = resumedRestart(snapshot, id, lastTimelineItem(snapshot, history));
  const next = restart ? [...saved, restart] : saved;

  if (restart) {
    await writeLocal(file, next);
  }

  return next.filter(isParentRestart.bind(undefined, state.threadId));
}

/** Own the live/durable restart boundary before publishing later native state.
@param bridge - Runtime whose current voice fragments may still be queued for disk.
*/
export async function recordBridgeRestart(bridge: Bridge) {
  const restartId = `pocket-restart:${crypto.randomUUID()}`;
  const live = resumedRestart(bridge.snapshot, restartId) ? bridge.realtime.beginTimelineBoundary(restartId) : [];
  const recorded = await t(recordRestart, bridge.snapshot, restartId, live);

  if (recorded.ok) {
    bridge.snapshot = { ...bridge.snapshot, restartEvents: recorded.value };
  }

  bridge.realtime.commitTimelineBoundary(restartId);

  if (!recorded.ok) {
    throw recorded.error;
  }
}
