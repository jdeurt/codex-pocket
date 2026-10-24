import { object } from "../../src/lib/protocol";
import { voiceWorkflow, TEST_SDP } from "../fixtures/voice-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

const LAST = -1;
const handoff = { name: "handoff_to_pocket", call_id: "cancelled", arguments: JSON.stringify({ request: "Do work." }) };

await test("realtime ignores cancelled tools and keeps audio connected when captions fail", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);

  flow.speech("unfinished");
  const first = await flow.response(0);

  first.done([handoff], "cancelled");
  flow.emit({ type: "conversation.item.input_audio_transcription.failed", item_id: "unfinished" });
  await eventually(() => flow.events.some((event) => event.type === "warning"), "Caption failure must remain visible");
  assert.equal(flow.voice.status().type, "active");
  assert.equal(flow.bridge.snapshot.turns.length, 0);
  assert.equal(flow.frames.filter((frame) => object(frame.item).type === "function_call_output").length, 0);
  await flow.voice.stop(started.token);
  const next = await flow.voice.start(TEST_SDP);

  assert.notEqual(next.token, started.token);
  assert.equal(flow.voice.owns(started.token), false);
  await flow.voice.stop(started.token);
  assert.equal(flow.voice.status().type, "active");
  flow.speech("fresh", "Hello again.");
  const fresh = await flow.response(1);

  fresh.send({ type: "response.output_audio_transcript.done", item_id: "greeting", transcript: "Welcome back." });
  fresh.done();
  await eventually(
    () => flow.events.some((event) => event.text === "Welcome back."),
    "Fresh session must own its reply"
  );
  await flow.voice.stop(next.token);
  assert.equal(flow.calls.filter((call) => call.action === "hangup").length, 2);
});

await test("realtime control disconnect releases its call and permits subsequent text work", async (t) => {
  const flow = await voiceWorkflow(t);

  await flow.voice.start(TEST_SDP);
  flow.peers.at(LAST)?.terminate();
  await eventually(() => flow.voice.status().type === "idle", "A lost control owner must release the call");
  assert.match(String(flow.voice.status().error), /disconnected/);
  await eventually(() => flow.calls.some((call) => call.action === "hangup"), "The remote call must be hung up");
  assert.deepEqual(await flow.bridge.send("typed", "Continue in text."), { id: "typed", status: "sent" });
  await eventually(
    () => flow.bridge.snapshot.turns.some((turn) => turn.status === "completed"),
    "The main agent must remain usable after voice disconnects"
  );
});

await test("realtime keeps worker results behind ongoing speech and ignores stale response completions", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);

  flow.speech("request");
  const request = await flow.response(0);

  request.done([{ ...handoff, call_id: "live-request" }]);
  flow.speech("correction");
  const correction = await flow.response(1);

  await eventually(
    () => flow.bridge.snapshot.turns.length === 1 && !flow.bridge.snapshot.activeTurnId,
    "Worker must complete while realtime is still responding to the correction"
  );
  request.done([{ ...handoff, call_id: "live-request" }]);
  correction.send({
    type: "response.output_audio_transcript.done",
    item_id: "still-speaking",
    transcript: "I heard your correction.",
  });
  await eventually(
    () => flow.events.some((event) => event.itemId === "still-speaking"),
    "Stale completion must be processed without ending the current response"
  );
  assert.equal(flow.frames.filter((frame) => object(frame.item).type === "function_call_output").length, 0);
  correction.done();
  const continuation = await flow.response(2);

  assert.equal(flow.frames.filter((frame) => object(frame.item).type === "function_call_output").length, 1);
  continuation.done();
  await flow.voice.stop(started.token);
});
