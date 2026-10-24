import { nativeText } from "../../src/server/harness/transcript";
import { object, dataSchema } from "../../src/lib/protocol";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import { VoiceHistory } from "../../src/server/voice-history";
import { voiceWorkflow, TEST_SDP } from "../fixtures/voice-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

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

  assert.equal(object(input.turn_detection).create_response, true);
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
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start(TEST_SDP);
  const storage = new VoiceHistory(flow.bridge.snapshot.threadId ?? "");
  const persist = storage.finalize.bind(storage);
  const blocked = Promise.withResolvers<undefined>();

  t.mock.method(VoiceHistory.prototype, "finalize", async (...args: Parameters<VoiceHistory["finalize"]>) => {
    await blocked.promise;

    return persist(...args);
  });

  try {
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
  } finally {
    blocked.resolve(undefined);
  }

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
