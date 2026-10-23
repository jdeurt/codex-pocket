/* eslint-disable @typescript-eslint/no-magic-numbers -- Provider-boundary flows assert exact turn counts and PCM dimensions. */
import { type Data, object } from "../src/lib/protocol";
import { openAIVoiceFixture, until } from "./fixtures/openai-voice";
import assert from "node:assert/strict";
import test from "node:test";

/** Complete an owned response with the provider's final output envelope.
@param calls - Confirmed tool calls, absent for spoken responses.
@returns Provider completion event.
*/
function completed(...calls: Data[]) {
  return {
    type: "response.done",
    response: { status: "completed", output: calls.map((call) => ({ type: "function_call", ...call })) },
  };
}

void test("OpenAI voice streams conversation and the actual accepted Pocket answer once through a receipt race", async (context) => {
  const flow = await openAIVoiceFixture();

  context.after(() => flow.close());
  const pcm = Buffer.alloc(4800, 1).toString("base64");
  const answer = "The issue is fixed. Interruptions now stop the previous answer.";

  const started = await flow.voice.start(flow.endpoint);

  flow.emit({ type: "input_audio_buffer.committed", item_id: "greeting" });
  flow.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "greeting", transcript: "Hi" });
  await until(() => flow.frames.filter((event) => event.type === "response.create").length === 1);
  flow.emit({ type: "response.output_audio.delta", item_id: "hello", delta: pcm });
  flow.emit({ type: "response.output_audio.delta", item_id: "hello", delta: pcm });
  flow.emit({ type: "response.output_audio_transcript.done", item_id: "hello", transcript: "Hi there." });
  flow.emit(completed());
  await until(() => flow.events.filter((event) => event.type === "audio").length === 2);
  assert.deepEqual(
    flow.events.filter((event) => event.type === "audio").map((event) => object(event.audio).data),
    [pcm, pcm]
  );

  flow.owner.handoff = (input) => {
    flow.handoffs.push(input);
    // A fast main answer can arrive before the durable dispatch acknowledgment settles.
    flow.voice.answer(input.id, answer);

    return Promise.resolve({ status: "queued" });
  };
  flow.emit({ type: "input_audio_buffer.speech_started", item_id: "request" });
  flow.emit({ type: "input_audio_buffer.committed", item_id: "request" });
  flow.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "request",
    transcript: "Please repair voice.",
  });
  await until(() => flow.frames.filter((event) => event.type === "response.create").length === 2);
  const request = flow.frames.findLast((event) => event.type === "response.create");
  const call = { name: "handoff_to_pocket", call_id: "delegate", arguments: "{}" };

  flow.emit(completed(call, { ...call, call_id: "duplicate" }));
  await until(() => flow.frames.filter((event) => event.type === "response.create").length === 3);
  const playback = object(flow.frames.findLast((event) => event.type === "response.create")?.response);

  assert.deepEqual(playback.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: answer }] },
  ]);
  assert.equal(playback.tool_choice, "none");
  assert.deepEqual(playback.output_modalities, ["audio"]);
  assert.equal(flow.handoffs.length, 1);
  assert.equal(flow.handoffs[0].id, `realtime:${started.nativeSessionId}:request`);
  flow.emit({
    ...completed(call),
    response: { ...completed(call).response, metadata: object(request?.response).metadata },
  });
  flow.voice.answer(flow.handoffs[0].id, answer);
  flow.emit({ type: "response.output_audio.delta", item_id: "answer", delta: pcm });
  await until(() => flow.events.filter((event) => event.type === "audio").length === 3);
  flow.emit({ type: "response.output_audio.delta", item_id: "answer", delta: pcm });
  flow.emit({ type: "response.output_audio_transcript.done", item_id: "answer", transcript: answer });
  flow.emit(completed());
  await until(() => flow.events.filter((event) => event.type === "audio").length === 4);
  await flow.voice.stop(started.token);
  assert.equal(flow.frames.filter((event) => event.type === "response.create").length, 3);
  assert.equal(flow.handoffs.length, 1);
  const history = await flow.voice.transcripts();

  assert.equal(history.find((entry) => entry.itemId === "request")?.handoff, "queued");
  assert.equal(history.find((entry) => entry.itemId === "hello")?.text, "Hi there.");
  // The actual main answer already has a canonical transcript row.
  assert.equal(history.filter((entry) => entry.role === "assistant").length, 1);
});

void test("OpenAI voice interrupts delegated playback and suppresses superseded and previous-session answers", async (context) => {
  const flow = await openAIVoiceFixture();

  context.after(() => flow.close());
  const pcm = Buffer.alloc(4800, 2).toString("base64");

  const started = await flow.voice.start(flow.endpoint);

  flow.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "old",
    transcript: "Inspect voice.",
  });
  await until(() => flow.frames.filter((event) => event.type === "response.create").length === 1);
  flow.emit(completed({ name: "handoff_to_pocket", call_id: "old-call", arguments: "{}" }));
  await until(() => flow.events.some((event) => event.type === "handoff" && event.itemId === "old"));
  flow.emit({ type: "input_audio_buffer.speech_started", item_id: "new" });
  flow.emit({ type: "input_audio_buffer.committed", item_id: "new" });
  flow.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "new",
    transcript: "Inspect switching instead.",
  });
  await until(() => flow.frames.filter((event) => event.type === "response.create").length === 2);
  flow.voice.answer(flow.handoffs[0].id, "Superseded result.");
  flow.emit(completed({ name: "handoff_to_pocket", call_id: "new-call", arguments: "{}" }));
  await until(() => flow.events.some((event) => event.type === "handoff" && event.itemId === "new"));
  flow.voice.answer(flow.handoffs[1].id, "Switching now drains captured speech.");
  await until(() => flow.frames.filter((event) => event.type === "response.create").length === 3);
  const playbackId = flow.responseId();
  const playback = flow.frames.findLast((event) => event.type === "response.create");

  flow.emit({ type: "response.output_audio.delta", item_id: "spoken-answer", delta: pcm });
  await until(() => flow.events.filter((event) => event.type === "audio").length === 1);
  flow.voice.truncate(started.token, "spoken-answer", 50);
  await until(() =>
    flow.frames.some((event) => event.type === "conversation.item.truncate" && event.audio_end_ms === 50)
  );
  flow.emit({ type: "input_audio_buffer.speech_started", item_id: "correction" });
  flow.emit({ type: "response.output_audio.delta", item_id: "spoken-answer", delta: pcm });
  flow.emit({ type: "response.output_audio_transcript.done", item_id: "spoken-answer", transcript: "Late result." });
  flow.emit({ ...completed(), response: { ...completed().response, status: "cancelled" } });
  flow.emit({ type: "input_audio_buffer.committed", item_id: "correction" });
  flow.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "correction",
    transcript: "Thanks.",
  });
  await until(() => flow.frames.filter((event) => event.type === "response.create").length === 4);
  flow.emit({ type: "response.output_audio.delta", response_id: playbackId, item_id: "spoken-answer", delta: pcm });
  flow.emit({ ...completed(), response: { ...completed().response, metadata: object(playback?.response).metadata } });
  flow.emit({ type: "response.output_audio.delta", item_id: "welcome", delta: pcm });
  flow.emit({ type: "response.output_audio_transcript.done", item_id: "welcome", transcript: "You're welcome." });
  flow.emit(completed());
  await until(() => flow.events.some((event) => event.type === "transcriptDone" && event.itemId === "welcome"));
  assert.equal(flow.events.filter((event) => event.type === "audio").length, 2);
  await flow.voice.stop(started.token);
  flow.voice.answer(flow.handoffs[1].id, "Result after stop.");
  const resumed = await flow.voice.start(flow.endpoint);

  flow.voice.answer(flow.handoffs[1].id, "Result from the previous session.");
  flow.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "fresh",
    transcript: "Hello again.",
  });
  await until(() => flow.frames.filter((event) => event.type === "response.create").length === 5);
  flow.emit({ type: "response.output_audio.delta", item_id: "fresh-reply", delta: pcm });
  flow.emit(completed());
  await until(() => flow.events.filter((event) => event.type === "audio").length === 3);
  await flow.voice.stop(resumed.token);
  assert.equal(flow.frames.filter((event) => event.type === "response.create").length, 5);
  assert.equal(flow.handoffs.length, 2);
});
