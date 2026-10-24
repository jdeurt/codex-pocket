import { type VoiceSegment } from "../../src/lib/voice-history";
import { type Snapshot, type Data } from "../../src/lib/protocol";
import { conversationTurns } from "../../src/state/conversation";
import { voiceTimeline } from "../../src/lib/voice-timeline";
import { visibleSnapshot } from "../../src/state/visible-snapshot";
import { recordBridgeRestart } from "../../src/server/restart-events";
import { VoiceHistory } from "../../src/server/voice-history";
import { voiceWorkflow, TEST_SDP } from "../fixtures/voice-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

const LAST = -1;
const INPUT_END_MS = 500;
const OUTPUT_START_MS = 600;
const REPLY_MID_MS = 700;
const REPLY_END_MS = 900;
const restartGate = Promise.withResolvers<undefined>();
const originalSave = Reflect.get<VoiceHistory, "save">(VoiceHistory.prototype, "save");

type Flow = Awaited<ReturnType<typeof voiceWorkflow>>;

/** Observe completed main work.
@param flow - Running workflow.
@returns Whether no main turn is active.
*/
function isMainIdle(flow: Flow) {
  return !flow.bridge.snapshot.activeTurnId;
}

/** Select an observed exact caption fragment.
@param text - Expected text.
@param frame - Published frame.
@returns Whether this caption matches.
*/
function isCaption(text: string, frame: Data) {
  return frame.text === text;
}

/** Observe captions without joining their persistence queue.
@param flow - Running workflow.
@param text - Expected text.
@returns Whether it was published.
*/
function hasText(flow: Flow, text: string) {
  return flow.events.some(isCaption.bind(undefined, text));
}

/** Hold restart-case writes while preserving the actual storage owner.
@param args - Immutable caption write.
@returns Original storage completion.
*/
async function blockedRestartSave(this: VoiceHistory, ...args: Parameters<VoiceHistory["save"]>) {
  await restartGate.promise;

  return originalSave.call(this, ...args);
}

/** Read voice and restart identities through the shared display projection.
@param snapshot - Canonical bridge snapshot.
@param history - Durable caption fragments.
@returns Chronological display identities.
*/
function voiceAndRestartIds(snapshot: Snapshot, history: VoiceSegment[]) {
  const timeline = voiceTimeline(conversationTurns(visibleSnapshot(snapshot), false, false), history, []);
  const ids: string[] = [];

  for (const turn of timeline) {
    for (const entry of turn.entries) {
      if (entry.kind === "message" && ["voiceMessage", "pocketRestart"].includes(entry.item.type)) {
        ids.push(entry.item.id);
      }
    }
  }

  return ids;
}

await test("restart boundary captures live captions before disk writes and splits continuous speech at the notice", async (t) => {
  t.after(restartGate.resolve.bind(undefined, undefined));
  const flow = await voiceWorkflow(t);

  await flow.bridge.send("seed-live-restart", "Keep history while voice stays connected.");
  await eventually(isMainIdle.bind(undefined, flow), "Seed work must finish");
  const started = await flow.voice.start(TEST_SDP);

  t.mock.method(VoiceHistory.prototype, "save", blockedRestartSave);
  flow.speech("before-user", "Keep speaking.", "user", 0, INPUT_END_MS);
  flow.speech("before-output", "Before the restart.", "assistant", OUTPUT_START_MS, REPLY_MID_MS);
  await eventually(
    hasText.bind(undefined, flow, "Before the restart."),
    "Live speech must publish before disk completes"
  );
  await recordBridgeRestart(flow.bridge);
  const restart = flow.bridge.snapshot.restartEvents?.at(LAST);

  assert.ok(restart);
  assert.equal(restart.afterItemId, `live:${started.nativeSessionId}:before-output`);
  flow.speech("after-output", "After the restart.", "assistant", REPLY_MID_MS, REPLY_END_MS);
  await eventually(
    hasText.bind(undefined, flow, "After the restart."),
    "Continuous speech must form a new group after the notice"
  );
  await flow.voice.stop(started.token);
  restartGate.resolve(undefined);
  const saved = await flow.voice.transcripts();

  assert.deepEqual(voiceAndRestartIds(flow.bridge.snapshot, saved), [
    `live:${started.nativeSessionId}:before-user`,
    `live:${started.nativeSessionId}:before-output`,
    restart.id,
    `live:${started.nativeSessionId}:after-output`,
  ]);
  assert.deepEqual(
    voiceAndRestartIds(flow.bridge.snapshot, await new VoiceHistory(flow.parent.id).read()),
    voiceAndRestartIds(flow.bridge.snapshot, saved)
  );
});
