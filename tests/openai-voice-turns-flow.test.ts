/* eslint-disable @typescript-eslint/no-magic-numbers -- Real provider-boundary flows assert exact turn and receipt counts. */
import { type Data, object } from "../src/lib/protocol";
import { openAIVoiceFixture, until } from "./fixtures/openai-voice";
import assert from "node:assert/strict";
import test from "node:test";

/** Build the provider's completed response envelope instead of executing argument-stream events.
@param calls - Function-call items confirmed by the provider.
@returns Completed response event carrying its final function-call output.
*/
function completed(...calls: Data[]) {
  return {
    type: "response.done",
    response: { status: "completed", output: calls.map((call) => ({ ...call, type: "function_call" })) },
  };
}

void test("OpenAI voice binds a handoff to its response when a later filler finalizes", async () => {
  const flow = await openAIVoiceFixture();

  try {
    await flow.voice.start(flow.endpoint);
    flow.emit({ type: "input_audio_buffer.committed", item_id: "request" });
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "request",
      transcript: "Can you kick off a side pocket for me and have it inspect voice?",
    });
    await until(() => flow.frames.some((event) => event.type === "response.create"));
    flow.emit({ type: "input_audio_buffer.committed", item_id: "filler", previous_item_id: "request" });
    flow.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "filler", transcript: "Um" });
    flow.emit(completed({ name: "handoff_to_pocket", call_id: "request-call", arguments: "{}" }));
    await until(() => flow.handoffs.length === 1);
    assert.equal(flow.handoffs[0].transcript, "Can you kick off a side pocket for me and have it inspect voice?");
    assert.equal(flow.voice.status().type, "active");
  } finally {
    await flow.close();
  }
});

void test("OpenAI voice assembles reordered finals and keeps repeated identical turns distinct", async () => {
  const flow = await openAIVoiceFixture();

  try {
    await flow.voice.start(flow.endpoint);
    flow.emit({ type: "input_audio_buffer.speech_started", item_id: "first" });
    flow.emit({ type: "input_audio_buffer.committed", item_id: "first" });
    flow.emit({ type: "input_audio_buffer.speech_started", item_id: "second" });
    flow.emit({ type: "input_audio_buffer.committed", item_id: "second", previous_item_id: "first" });
    flow.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "first", delta: "Can you" });
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "second",
      transcript: "inspect voice processing?",
    });
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "first",
      transcript: "Can you start a side pocket and have it",
    });
    await until(() => flow.frames.some((frame) => frame.type === "response.create"));
    const response = flow.frames.find((frame) => frame.type === "response.create");

    assert.ok(response);
    const call = { name: "handoff_to_pocket", call_id: "multi", arguments: "{}" };

    flow.emit(completed(call));
    await until(() => flow.handoffs.length === 1);
    assert.equal(flow.handoffs[0].transcript, "Can you start a side pocket and have it\ninspect voice processing?");
    const firstReceipt = flow.handoffs[0].id;

    flow.emit({ type: "input_audio_buffer.committed", item_id: "repeat" });
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "repeat",
      transcript: flow.handoffs[0].transcript,
    });
    await until(() => flow.frames.filter((frame) => frame.type === "response.create").length === 2);
    // A repeated completion belongs to its original response, even while another turn is active.
    flow.emit({
      ...completed(call),
      response: { ...completed(call).response, metadata: object(response.response).metadata },
    });
    flow.emit(completed({ name: "handoff_to_pocket", call_id: "repeat-call", arguments: "{}" }));
    await until(() => flow.handoffs.length === 2);
    assert.notEqual(flow.handoffs[1].id, firstReceipt);
    assert.equal(flow.handoffs[1].transcript, flow.handoffs[0].transcript);
    const history = await flow.voice.transcripts();

    assert.equal(history.filter((entry) => entry.handoff === "sent").length, 3);
  } finally {
    await flow.close();
  }
});

void test(
  "OpenAI voice bounds a lost dispatch acknowledgment without replaying a late accepted action",
  { timeout: 25_000 },
  async () => {
    const flow = await openAIVoiceFixture();
    const delivery = Promise.withResolvers<{ status: string }>();

    let calls = 0;

    flow.owner.handoff = () => {
      calls++;

      return delivery.promise;
    };

    try {
      await flow.voice.start(flow.endpoint);
      flow.emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "uncertain",
        transcript: "Create one side pocket.",
      });
      await until(() => flow.frames.some((event) => event.type === "response.create"));
      const failed = new Promise<void>((resolve) => {
        flow.voice.addEventListener(
          "message",
          (event) => {
            if (event instanceof CustomEvent && object(event.detail).type === "error") {
              resolve();
            }
          },
          { once: true }
        );
      });

      flow.emit(completed({ name: "handoff_to_pocket", call_id: "uncertain-call", arguments: "{}" }));
      await failed;
      assert.equal(flow.voice.status().type, "idle");
      const saved = await flow.voice.transcripts();

      assert.equal(saved[0].handoff, "unknown");
      delivery.resolve({ status: "sent" });
      await flow.voice.retry(saved[0].id);
      assert.equal(calls, 1);
      const resumed = await flow.voice.start(flow.endpoint);

      await flow.voice.stop(resumed.token);
      assert.equal(calls, 1);
      assert.equal(saved[0].handoff, "unknown");
    } finally {
      delivery.resolve({ status: "sent" });
      await flow.close();
    }
  }
);
