import { type VoiceSegment } from "../../src/lib/voice-history";
import { conversationTurns } from "../../src/state/conversation";
import { voiceTimeline } from "../../src/lib/voice-timeline";
import { nativeText } from "../../src/state/harness-transcript";
import { type Snapshot, type Data, object } from "../../src/lib/protocol";
import { visibleSnapshot } from "../../src/state/visible-snapshot";
import { groupedVoiceSegments } from "../../src/state/voice";
import { readCostReport } from "../../src/server/cost-store";
import { VoiceHistory } from "../../src/server/voice-history";
import { voiceWorkflow, TEST_SDP } from "../fixtures/voice-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

const COST_WINDOW_MS = 60_000;
const LAST = -1;
const RESULT_BYTES = 400;
const INPUT_END_MS = 500;
const OUTPUT_START_MS = 600;
const REPLY_MID_MS = 700;
const REPLY_END_MS = 900;
const persistenceGate = Promise.withResolvers<undefined>();
const originalSave = Reflect.get<VoiceHistory, "save">(VoiceHistory.prototype, "save");

type Flow = Awaited<ReturnType<typeof voiceWorkflow>>;

/** Select observed captions by exact text.
@param text - Expected fragment.
@param entry - Observed frame.
@returns Whether text matches.
*/
function isMatchingText(text: string, entry: { text?: unknown }) {
  return entry.text === text;
}

/** Observe visible captions without waiting for disk writes.
@param flow - Running workflow.
@param text - Expected caption fragment.
@returns Whether the application has published it.
*/
function hasText(flow: Flow, text: string) {
  return flow.events.some(isMatchingText.bind(undefined, text));
}

/** Select native commentary appends.
@param frame - Provider command.
@returns Whether it carries backend context.
*/
function isCommentary(frame: { type?: unknown }) {
  return frame.type === "session.commentary.append";
}

/** Observe completed main work and a returned client-delegation result.
@param flow - Running workflow.
@returns Whether main work has returned verified context.
*/
function hasResult(flow: Flow) {
  return flow.frames.some(isCommentary.bind(undefined)) && !flow.bridge.snapshot.activeTurnId;
}

/** Select public turn items.
@param turn - Projected public turn.
@returns Its visible items.
*/
function turnItems(turn: Snapshot["turns"][number]) {
  return turn.items;
}

/** Select exact observed text.
@param entry - Caption fragment or group.
@returns Text.
*/
function segmentText(entry: VoiceSegment) {
  return entry.text;
}

/** Select the provider command name.
@param frame - Captured command.
@returns Event name.
*/
function frameType(frame: { type?: unknown }) {
  return frame.type;
}

/** Hold actual storage writes without replacing the history owner's cache.
@param args - Exact immutable caption write.
@returns Original storage completion.
*/
async function blockedSave(this: VoiceHistory, ...args: Parameters<VoiceHistory["save"]>) {
  await persistenceGate.promise;

  return originalSave.call(this, ...args);
}

/** Observe completion of a requested main turn.
@param flow - Running workflow.
@returns Whether no main turn is active.
*/
function isMainIdle(flow: Flow) {
  return !flow.bridge.snapshot.activeTurnId;
}

/** Select native items matching a client request.
@param id - Client request identity.
@param item - Native item.
@returns Whether it belongs to the request.
*/
function isMatchingClient(id: string, item: Data) {
  return item.clientId === id;
}

/** Send native media-timed captions and await their immediate publication.
@param flow - Running workflow.
@param id - Exchange identity.
*/
async function spokenExchange(flow: Flow, id: string) {
  flow.speech(`${id}-user`, `Question ${id}`, "user", 0, INPUT_END_MS);
  flow.speech(id, `Answer ${id}`, "assistant", OUTPUT_START_MS);
  await eventually(hasText.bind(undefined, flow, `Answer ${id}`), "Speech must publish before restart");
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

/** Select durable display identities.
@param entry - Caption group.
@returns Stable group identity.
*/
function segmentId(entry: VoiceSegment) {
  return entry.id;
}

/** Observe graceful close submission while provider finalization is held.
@param flow - Running workflow.
@returns Whether close has reached the sideband.
*/
function isClosing(flow: Flow) {
  return flow.frames.map(frameType.bind(undefined)).includes("session.close");
}

/** Select emergency provider hangups.
@param call - Observed HTTP operation.
@returns Whether it is a fallback hangup.
*/
function isHangup(call: { action?: unknown }) {
  return call.action === "hangup";
}

await test("Live reserves delegation before captions and returns verified context without a speech restart", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);
  const session = object(flow.calls[0].session);

  assert.equal(session.model, "gpt-live-1");
  assert.deepEqual(session.delegation, { type: "client" });
  assert.equal(object(session.audio).input, undefined);
  assert.equal(session.tools, undefined);
  assert.equal(flow.frames.length, 0);
  flow.delegation("worker-request", INPUT_END_MS);
  flow.delegation("worker-request", INPUT_END_MS);
  flow.speech("request", "Inspect the audio transport.", "user", 0, INPUT_END_MS);
  await eventually(hasResult.bind(undefined, flow), "Native delegation must return through commentary context");
  const result = flow.frames.filter(isCommentary.bind(undefined));

  assert.equal(result.length, 1);
  assert.equal(result[0].delegation_id, "worker-request");
  assert.match(String(result[0].content), /Voice repair completed/);
  assert.ok(Buffer.byteLength(String(result[0].content)) <= RESULT_BYTES);
  assert.equal(flow.bridge.snapshot.turns.length, 1);
  assert.match(nativeText(flow.bridge.snapshot.turns[0].items[0].content), /Inspect the audio transport/);
  assert.equal(visibleSnapshot(flow.bridge.snapshot).turns.flatMap(turnItems.bind(undefined)).length, 0);
  flow.speech("reply", "I checked the audio path.", "assistant", OUTPUT_START_MS);
  await eventually(hasText.bind(undefined, flow, "I checked the audio path."), "Captions must stream independently");
  await flow.voice.stop(started.token);
  assert.deepEqual(groupedVoiceSegments(await flow.voice.transcripts()).map(segmentText.bind(undefined)), [
    "Inspect the audio transport.",
    "I checked the audio path.",
  ]);
  assert.deepEqual(flow.frames.map(frameType.bind(undefined)), ["session.commentary.append", "session.close"]);
});

await test("Live captions and delegation continue while immutable transcript persistence is blocked", async (t) => {
  t.after(persistenceGate.resolve.bind(undefined, undefined));
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);

  t.mock.method(VoiceHistory.prototype, "save", blockedSave);
  flow.speech("request", "Check the buffer.");
  flow.delegation("check-buffer");
  flow.speech("reply", "I am looking into it.", "assistant", OUTPUT_START_MS);
  await eventually(hasText.bind(undefined, flow, "I am looking into it."), "Slow disk must not gate live captions");
  await eventually(hasResult.bind(undefined, flow), "Slow disk must not gate delegation");
  await flow.voice.stop(started.token);
  assert.equal(flow.voice.status().type, "idle");
  persistenceGate.resolve(undefined);
  const saved = await flow.voice.transcripts();

  assert.equal(saved.length, 2);
});

await test("Live groups late overlapping fragments by media time and preserves typed continuation", async (t) => {
  const flow = await voiceWorkflow(t);

  await flow.bridge.send("before-voice", "We agreed to use blue for the settings page.");
  await eventually(isMainIdle.bind(undefined, flow), "Initial typed work must finish");
  const started = await flow.voice.start(TEST_SDP);
  const session = object(flow.calls[0].session);

  assert.match(JSON.stringify(session.input), /We agreed to use blue/);
  flow.speech("reply-one", "Green, ", "assistant", OUTPUT_START_MS, REPLY_MID_MS);
  flow.speech("late-user", "Actually, make that green.", "user", 0, INPUT_END_MS);
  flow.speech("reply-two", "understood.", "assistant", REPLY_MID_MS, REPLY_END_MS);
  flow.speech("reply-two", "understood.", "assistant", REPLY_MID_MS, REPLY_END_MS);
  await eventually(hasText.bind(undefined, flow, "understood."), "Immutable fragments must be observed immediately");
  await flow.voice.stop(started.token);
  const groups = groupedVoiceSegments(await flow.voice.transcripts());

  assert.deepEqual(groups.map(segmentText.bind(undefined)), ["Actually, make that green.", "Green, understood."]);
  await flow.bridge.send("after-voice", "Use that color for the button too.");
  await eventually(isMainIdle.bind(undefined, flow), "Typed continuation must finish");
  const { thread } = await flow.bridge
    .agentReader()
    .request("thread/read", { threadId: flow.parent.id, includeTurns: true });
  const native = thread.turns.flatMap(turnItems.bind(undefined)).find(isMatchingClient.bind(undefined, "after-voice"));
  const input = nativeText(native?.content);

  assert.match(input, /Actually, make that green/);
  assert.match(input, /Green, understood/);
  assert.ok(input.indexOf("Actually, make that green") < input.indexOf("Green, understood"));
  assert.match(input, /context_only_no_new_user_authorization/);
  const visible = flow.bridge.snapshot.turns
    .flatMap(turnItems.bind(undefined))
    .find(isMatchingClient.bind(undefined, "after-voice"));

  assert.equal(nativeText(visible?.content), "Use that color for the button too.");
});

await test("voice and restart notices retain event order across native reconnects and history reloads", async (t) => {
  const flow = await voiceWorkflow(t);

  await flow.bridge.send("seed-history", "Create ordinary history before speaking.");
  await eventually(isMainIdle.bind(undefined, flow), "Seed reply must finish");
  const firstCall = await flow.voice.start(TEST_SDP);

  await spokenExchange(flow, "before-restart");
  await flow.voice.stop(firstCall.token);
  const firstHistory = groupedVoiceSegments(await flow.voice.transcripts());

  await flow.bridge.agentReader().shutdown();
  await flow.bridge.ensureConnected();
  const firstRestart = flow.bridge.snapshot.restartEvents?.at(LAST);

  assert.ok(firstRestart);
  assert.equal(firstRestart.afterItemId, firstHistory.at(LAST)?.id);
  const secondCall = await flow.voice.start(TEST_SDP);

  await spokenExchange(flow, "after-restart");
  await flow.voice.stop(secondCall.token);
  const history = await new VoiceHistory(flow.bridge.snapshot.threadId ?? "").read();
  const expected = [
    ...firstHistory.map(segmentId.bind(undefined)),
    firstRestart.id,
    ...groupedVoiceSegments(history).slice(firstHistory.length).map(segmentId.bind(undefined)),
  ];

  assert.deepEqual(voiceAndRestartIds(flow.bridge.snapshot, history), expected);
  await flow.bridge.agentReader().shutdown();
  await flow.bridge.ensureConnected();
  const secondRestart = flow.bridge.snapshot.restartEvents?.at(LAST);

  assert.ok(secondRestart);
  assert.deepEqual(voiceAndRestartIds(flow.bridge.snapshot, history), [...expected, secondRestart.id]);
});

await test("backend voice hangup waits for final usage and preserves active main-agent work", async (t) => {
  const flow = await voiceWorkflow(t, { turn: { hold: true } });

  await flow.bridge.send("ongoing-work", "Keep investigating while I use voice.");
  const activeTurnId = flow.bridge.snapshot.activeTurnId;

  assert.ok(activeTurnId);
  const started = await flow.voice.start(TEST_SDP);

  flow.speech("end-request", "Please end the call.");
  await eventually(hasText.bind(undefined, flow, "Please end the call."), "User request must remain visible");
  flow.provider.shouldFinalize = false;
  const ending = flow.voice.endSession(started.nativeSessionId);

  await eventually(isClosing.bind(undefined, flow), "Hangup must request graceful finalization");
  assert.equal(flow.voice.status().type, "stopping");
  assert.equal(flow.peers.at(LAST)?.readyState, flow.peers.at(LAST)?.OPEN);
  assert.equal(flow.bridge.snapshot.activeTurnId, activeTurnId);
  flow.emit({ type: "session.closed", usage: { seconds: 2 }, reason: "client_close" });
  assert.equal(await ending, true);
  const costs = readCostReport({
    start: new Date(Date.now() - COST_WINDOW_MS).toISOString(),
    end: new Date(Date.now() + COST_WINDOW_MS).toISOString(),
    timezone: "UTC",
    feature: "voice",
  });

  assert.equal(costs.groups[0]?.calls, 1);
  assert.equal(costs.groups[0]?.seconds, 2);
  assert.equal(flow.voice.owns(started.token), false);
  assert.equal(flow.calls.filter(isHangup.bind(undefined)).length, 0);
  const next = await flow.voice.start(TEST_SDP);

  assert.equal(await flow.voice.endSession(started.nativeSessionId), false);
  assert.equal(flow.voice.status().type, "active");
  flow.provider.shouldFinalize = true;
  await flow.voice.stop(next.token);
  assert.equal(flow.bridge.snapshot.activeTurnId, activeTurnId);
});
