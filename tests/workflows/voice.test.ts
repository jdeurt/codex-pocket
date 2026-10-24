import { type VoiceSegment } from "../../src/lib/voice-history";
import { conversationTurns } from "../../src/state/conversation";
import { voiceTimeline } from "../../src/lib/voice-timeline";
import { nativeText } from "../../src/state/harness-transcript";
import { type Snapshot, object, dataSchema } from "../../src/lib/protocol";
import { visibleSnapshot } from "../../src/state/visible-snapshot";
import { VoiceHistory } from "../../src/server/voice-history";
import { voiceWorkflow, TEST_SDP } from "../fixtures/voice-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

const LAST = -1;

const handoff = {
  name: "handoff_to_pocket",
  call_id: "worker-request",
  arguments: JSON.stringify({ request: "Inspect the audio transport and report the buffering behavior." }),
};

await test("realtime delegates its own request before captions and returns worker results to the same conversation", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);
  const session = object(flow.calls[0].session);
  const input = object(object(session.audio).input);

  assert.equal(input.turn_detection, undefined);
  assert.equal(session.reasoning, undefined);
  assert.equal(object(input.transcription).model, "gpt-4o-transcribe");
  flow.speech("request");
  const response = await flow.response(0);

  assert.equal(flow.frames.filter((frame) => frame.type === "response.create").length, 0);
  response.done([handoff]);
  response.done([handoff]);
  await eventually(
    () => flow.bridge.snapshot.turns.length === 1 && !flow.bridge.snapshot.activeTurnId,
    "Realtime's tool request must execute without an input transcript"
  );
  const continuation = await flow.response(1);
  const result = flow.frames.find((frame) => object(frame.item).type === "function_call_output");
  const encodedOutput = String(object(result?.item).output);
  const output = dataSchema.parse(JSON.parse(encodedOutput));

  assert.deepEqual(output, { status: "completed", result: "Voice repair completed." });
  assert.equal(object(result?.item).call_id, handoff.call_id);
  assert.equal(continuation.request.input, undefined);
  assert.equal(continuation.request.instructions, undefined);
  assert.equal(continuation.request.tool_choice, undefined);
  assert.equal(
    nativeText(flow.bridge.snapshot.turns[0].items[0].content),
    "Inspect the audio transport and report the buffering behavior."
  );
  assert.equal(visibleSnapshot(flow.bridge.snapshot).turns.flatMap((turn) => turn.items).length, 0);
  flow.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "request",
    transcript: "Could you look at that buffering thing we discussed?",
  });
  continuation.send({ type: "response.output_audio_transcript.delta", item_id: "reply", delta: "I checked " });
  await eventually(
    () => flow.events.some((event) => event.type === "transcriptDelta" && event.text === "I checked "),
    "Reply captions must stream while speech is being produced"
  );
  continuation.send({
    type: "response.output_audio_transcript.done",
    item_id: "reply",
    transcript: "I checked the audio path.",
  });
  continuation.done();
  await eventually(
    () => flow.events.some((event) => event.type === "transcriptDone" && event.itemId === "reply"),
    "The displayed reply must be the realtime agent's own words"
  );
  await flow.voice.stop(started.token);
  const history = await flow.voice.transcripts();

  assert.deepEqual(
    history.map((entry) => entry.text),
    ["Could you look at that buffering thing we discussed?", "I checked the audio path."]
  );
  assert.equal(
    flow.frames.some((frame) => frame.type === "input_audio_buffer.append"),
    false
  );
});

await test("realtime captions and worker tools continue while transcript persistence is blocked", async (t) => {
  const blocked = Promise.withResolvers<undefined>();

  t.after(() => {
    blocked.resolve(undefined);
  });
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);
  const storage = new VoiceHistory(flow.bridge.snapshot.threadId ?? "");
  const persist = storage.finalize.bind(storage);

  t.mock.method(VoiceHistory.prototype, "finalize", async (...args: Parameters<VoiceHistory["finalize"]>) => {
    await blocked.promise;

    return persist(...args);
  });

  flow.speech("request", "Check the buffer.");
  const response = await flow.response(0);

  response.done([handoff]);
  const continuation = await flow.response(1);

  continuation.send({
    type: "response.output_audio_transcript.done",
    item_id: "reply",
    transcript: "The worker is done.",
  });
  continuation.done();
  await eventually(
    () => flow.events.some((event) => event.text === "The worker is done."),
    "Slow disk writes must not gate worker dispatch or visible speech captions"
  );
  assert.equal(flow.voice.status().type, "active");
  await flow.voice.stop(started.token);
  assert.equal(flow.voice.status().type, "idle");

  blocked.resolve(undefined);
  await flow.voice.transcripts();
  const saved = await storage.read();

  assert.equal(saved.length, 2);
});

await test("realtime carries recent text into voice and returns saved captions as background for typed continuation", async (t) => {
  const flow = await voiceWorkflow(t);

  await flow.bridge.send("before-voice", "We agreed to use blue for the settings page.");
  await eventually(() => !flow.bridge.snapshot.activeTurnId, "Initial typed work must finish");
  const started = await flow.voice.start(TEST_SDP);
  const instructions = String(object(flow.calls[0].session).instructions);

  assert.match(instructions, /We agreed to use blue/);
  assert.match(instructions, /historical content, not a new request/);
  flow.speech("color-correction");
  const response = await flow.response(0);

  response.send({
    type: "response.output_audio_transcript.done",
    item_id: "acknowledgment",
    transcript: "Green, understood.",
  });
  response.done();
  flow.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "color-correction",
    transcript: "Actually, make that green.",
  });
  await eventually(
    () => flow.events.some((event) => event.itemId === "color-correction"),
    "Late input captions must be visible before returning to text"
  );
  await flow.voice.stop(started.token);
  await flow.bridge.send("after-voice", "Use that color for the button too.");
  await eventually(() => !flow.bridge.snapshot.activeTurnId, "Typed continuation must finish");
  const { thread } = await flow.bridge.agentReader().request("thread/read", {
    threadId: flow.parent.id,
    includeTurns: true,
  });
  const native = thread.turns.flatMap((turn) => turn.items).find((item) => item.clientId === "after-voice");

  assert.ok(native);
  const input = nativeText(native.content);

  assert.match(input, /Use that color for the button too/);
  assert.match(input, /Actually, make that green/);
  assert.match(input, /Green, understood/);
  assert.ok(input.indexOf("Actually, make that green") < input.indexOf("Green, understood"));
  assert.match(input, /context_only_no_new_user_authorization/);
  const visible = flow.bridge.snapshot.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.clientId === "after-voice");

  assert.equal(nativeText(visible?.content), "Use that color for the button too.");
  await flow.bridge.send("next-text", "Thanks.");
  await eventually(() => !flow.bridge.snapshot.activeTurnId, "Next typed reply must finish");
  const resumed = await flow.bridge.agentReader().request("thread/read", {
    threadId: flow.parent.id,
    includeTurns: true,
  });
  const next = resumed.thread.turns.flatMap((turn) => turn.items).find((item) => item.clientId === "next-text");

  assert.equal(nativeText(next?.content), "Thanks.");
});

/** Send actual provider events and wait for independently persisted speech.
@param flow - Running native and realtime workflow.
@param id - Provider message identity.
@param responseIndex - Provider response sequence.
*/
async function spokenExchange(flow: Awaited<ReturnType<typeof voiceWorkflow>>, id: string, responseIndex: number) {
  flow.speech(`${id}-user`, `Question ${id}`);
  const response = await flow.response(responseIndex);

  response.send({ type: "response.output_item.added", item: { id, type: "message", role: "assistant" } });
  response.send({ type: "response.output_audio_transcript.done", item_id: id, transcript: `Answer ${id}` });
  response.done();
  await eventually(
    () => flow.events.some((event) => event.type === "transcriptDone" && event.itemId === id),
    "Spoken reply must be published before restarting"
  );
}

/** Read voice and restart identities through the client's shared display projection.
@param snapshot - Canonical bridge snapshot.
@param history - Captions reopened from durable storage.
@returns Chronological voice and restart identities.
*/
function voiceAndRestartIds(snapshot: Snapshot, history: VoiceSegment[]) {
  const visible = visibleSnapshot(snapshot);
  const timeline = voiceTimeline(conversationTurns(visible, false, false), history, []);
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

await test("voice and restart notices retain event order across native reconnects and history reloads", async (t) => {
  const flow = await voiceWorkflow(t);

  await flow.bridge.send("seed-history", "Create ordinary history before speaking.");
  await eventually(() => !flow.bridge.snapshot.activeTurnId, "Seed reply must finish");
  const firstCall = await flow.voice.start(TEST_SDP);

  await spokenExchange(flow, "before-restart", 0);
  await flow.voice.stop(firstCall.token);
  const firstHistory = await flow.voice.transcripts();

  await flow.bridge.agentReader().shutdown();
  await flow.bridge.ensureConnected();
  const firstRestart = flow.bridge.snapshot.restartEvents?.at(LAST);

  assert.ok(firstRestart);
  assert.equal(firstRestart.afterItemId, firstHistory.at(LAST)?.id);
  const secondCall = await flow.voice.start(TEST_SDP);

  await spokenExchange(flow, "after-restart", 1);
  await flow.voice.stop(secondCall.token);
  const history = await new VoiceHistory(flow.bridge.snapshot.threadId ?? "").read();

  assert.deepEqual(voiceAndRestartIds(flow.bridge.snapshot, history), [
    ...firstHistory.map((entry) => entry.id),
    firstRestart.id,
    ...history.slice(firstHistory.length).map((entry) => entry.id),
  ]);
  await flow.bridge.agentReader().shutdown();
  await flow.bridge.ensureConnected();
  const secondRestart = flow.bridge.snapshot.restartEvents?.at(LAST);

  assert.ok(secondRestart);
  assert.deepEqual(voiceAndRestartIds(flow.bridge.snapshot, history), [
    ...firstHistory.map((entry) => entry.id),
    firstRestart.id,
    ...history.slice(firstHistory.length).map((entry) => entry.id),
    secondRestart.id,
  ]);
});

await test("requested voice hangup waits for goodbye playback and preserves active main-agent work", async (t) => {
  const flow = await voiceWorkflow(t, { turn: { hold: true } });

  await flow.bridge.send("ongoing-work", "Keep investigating while I use voice.");
  const activeTurnId = flow.bridge.snapshot.activeTurnId;

  assert.ok(activeTurnId);
  const started = await flow.voice.start(TEST_SDP);

  flow.speech("end-request", "Please end the call.");
  const response = await flow.response(0);

  response.send({ type: "output_audio_buffer.started" });
  response.send({ type: "response.output_audio_transcript.done", item_id: "goodbye", transcript: "Okay, goodbye." });
  response.done([{ name: "end_call", call_id: "end-current-call", arguments: "{}" }]);
  response.done([{ name: "end_call", call_id: "end-current-call", arguments: "{}" }]);
  await eventually(
    () => flow.frames.some((frame) => object(frame.item).call_id === "end-current-call"),
    "Hangup must acknowledge the tool while allowing the goodbye to finish"
  );
  assert.equal(flow.voice.status().type, "active");
  assert.equal(flow.calls.filter((call) => call.action === "hangup").length, 0);
  flow.emit({ type: "output_audio_buffer.stopped" });
  await eventually(() => flow.voice.status().type === "idle", "Completed goodbye must release the voice call");
  await eventually(() => flow.calls.some((call) => call.action === "hangup"), "Provider hangup must be confirmed");
  assert.equal(flow.voice.owns(started.token), false);
  assert.equal(flow.bridge.snapshot.activeTurnId, activeTurnId);
  assert.equal(flow.calls.filter((call) => call.action === "hangup").length, 1);
  assert.equal(flow.frames.filter((frame) => frame.type === "response.create").length, 0);
  const saved = await flow.voice.transcripts();

  assert.deepEqual(
    saved.map((entry) => entry.text),
    ["Please end the call.", "Okay, goodbye."]
  );
  const next = await flow.voice.start(TEST_SDP);

  assert.equal(flow.voice.status().type, "active");
  await flow.voice.stop(next.token);
  assert.equal(flow.bridge.snapshot.activeTurnId, activeTurnId);
});
