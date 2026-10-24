import { voiceWorkflow, TEST_SDP } from "../fixtures/voice-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

const LAST = -1;

type Flow = Awaited<ReturnType<typeof voiceWorkflow>>;

/** Observe released provider ownership.
@param flow - Running workflow.
@returns Whether the call has ended.
*/
function isIdle(flow: Flow) {
  return flow.voice.status().type === "idle";
}

/** Select emergency provider hangups.
@param call - Captured provider operation.
@returns Whether this is a hangup.
*/
function isHangup(call: { action?: unknown }) {
  return call.action === "hangup";
}

/** Observe provider fallback cleanup.
@param flow - Running workflow.
@returns Whether a remote hangup was attempted.
*/
function hasHangup(flow: Flow) {
  return flow.calls.some(isHangup.bind(undefined));
}

/** Observe completion of main work.
@param flow - Running workflow.
@returns Whether a main turn completed.
*/
function isMainComplete(flow: Flow) {
  return flow.bridge.snapshot.turns.length > 0 && !flow.bridge.snapshot.activeTurnId;
}

/** Select native commentary result commands.
@param frame - Captured provider command.
@returns Whether it is a context append.
*/
function isCommentary(frame: { type?: unknown }) {
  return frame.type === "session.commentary.append";
}

/** Observe backend context returning independently of ongoing speech.
@param flow - Running workflow.
@returns Whether a verified result has arrived.
*/
function hasResult(flow: Flow) {
  return flow.frames.some(isCommentary.bind(undefined));
}

/** Select graceful closure commands.
@param frame - Provider command.
@returns Whether this command closes the session.
*/
function isClose(frame: { type?: unknown }) {
  return frame.type === "session.close";
}

/** Observe a pending graceful close without completing the session.
@param flow - Running workflow.
@returns Whether close was submitted.
*/
function isClosing(flow: Flow) {
  return flow.frames.some(isClose.bind(undefined));
}

await test("Live ignores malformed captions and stale hangups while allowing a fresh call", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);

  flow.delegation("waiting-for-user");
  flow.emit({ type: "session.input_transcript.delta", event_id: "invalid", delta: "Do not invent timing." });
  flow.emit({ type: "session.output_audio.delta", delta: "private-reflected-audio", start_ms: 0, end_ms: 1 });
  await flow.voice.stop(started.token);
  assert.equal(flow.bridge.snapshot.turns.length, 0);
  assert.equal(flow.frames.filter(isCommentary.bind(undefined)).length, 0);
  const next = await flow.voice.start(TEST_SDP);

  assert.notEqual(next.token, started.token);
  await flow.voice.stop(started.token);
  assert.equal(await flow.voice.endSession(started.nativeSessionId), false);
  assert.equal(flow.voice.status().type, "active");
  await flow.voice.stop(next.token);
  assert.equal(flow.calls.filter(isHangup.bind(undefined)).length, 0);
});

await test("Live control disconnect releases its call and permits subsequent text work", async (t) => {
  const flow = await voiceWorkflow(t);

  await flow.voice.start(TEST_SDP);
  flow.peers.at(LAST)?.terminate();
  await eventually(isIdle.bind(undefined, flow), "A lost control owner must release the call");
  assert.match(String(flow.voice.status().error), /disconnected/);
  await eventually(hasHangup.bind(undefined, flow), "An unconfirmed call must attempt emergency hangup");
  assert.deepEqual(await flow.bridge.send("typed", "Continue in text."), { id: "typed", status: "sent" });
  await eventually(isMainComplete.bind(undefined, flow), "Main agent must remain usable after voice disconnects");
});

await test("Live returns worker context during ongoing speech without waiting for obsolete response events", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);

  flow.speech("request", "Inspect the audio transport.");
  flow.delegation("live-request");
  flow.speech("speaking", "I am looking into it.", "assistant");
  await eventually(hasResult.bind(undefined, flow), "Backend context must not wait for speech completion");
  flow.delegation("live-request");
  flow.speech("correction", "Please inspect buffering too.");
  await flow.voice.stop(started.token);
  assert.equal(flow.frames.filter(isCommentary.bind(undefined)).length, 1);
  assert.equal(flow.bridge.snapshot.turns.length, 1);
});

await test("Live reports unconfirmed finalization when the sideband closes during hangup", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);

  flow.provider.shouldFinalize = false;
  const stopped = flow.voice.stop(started.token);
  const rejected = assert.rejects(stopped, /finalization could not be confirmed/);

  await eventually(isClosing.bind(undefined, flow), "The provider must receive graceful close first");
  flow.peers.at(LAST)?.terminate();
  await rejected;
  assert.equal(flow.voice.status().type, "idle");
  assert.equal(flow.calls.filter(isHangup.bind(undefined)).length, 1);
});
