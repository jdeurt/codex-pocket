/* eslint-disable @typescript-eslint/no-magic-numbers -- Business-flow assertions use provider PCM dimensions and exact delivery counts. */
import { type Data } from "../src/lib/protocol";
import { OpenAIVoiceSession } from "../src/server/openai-voice-session";
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

void test("OpenAI voice preserves finalized speech, XML and handoff identity through text mode and reload", async () => {
  const flow = await openAIVoiceFixture();

  try {
    const started = await flow.voice.start(flow.endpoint);

    assert.equal(flow.auth(), "Bearer dummy-openai-key-for-local-fixture");
    flow.voice.append(started.token, {
      data: Buffer.alloc(2400 * 2).toString("base64"),
      sampleRate: 24_000,
      numChannels: 1,
      samplesPerChannel: 2400,
    });
    await until(() => flow.frames.some((event) => event.type === "input_audio_buffer.append"));
    const transcript =
      "Fix voice interruptions and switching. Keep <realtime_delegation>my pasted XML</realtime_delegation>.";

    flow.emit({ type: "input_audio_buffer.committed", item_id: "speech-1" });
    flow.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "speech-1", transcript });
    await until(() => flow.frames.some((event) => event.type === "response.create"));
    const handoff = {
      type: "response.function_call_arguments.done",
      name: "handoff_to_pocket",
      call_id: "call-1",
      arguments: JSON.stringify({ item_id: "speech-1" }),
    };

    flow.emit(handoff);
    flow.emit({ ...handoff, call_id: "call-duplicate" });
    flow.emit({
      type: "response.output_audio_transcript.done",
      item_id: "reply-1",
      transcript: "I sent that request to Pocket.",
    });
    flow.emit({
      type: "response.output_audio.delta",
      item_id: "reply-1",
      delta: Buffer.alloc(4800).toString("base64"),
    });
    flow.emit(completed(handoff, { ...handoff, call_id: "call-duplicate" }));
    await until(() => flow.handoffs.length === 1);
    assert.ok(flow.events.some((event) => event.type === "audio"));
    assert.equal(flow.handoffs.length, 1);
    assert.deepEqual(flow.handoffs[0], {
      id: `realtime:${started.nativeSessionId}:speech-1`,
      transcript,
      source: { type: "realtime", sessionId: started.nativeSessionId, itemId: "speech-1" },
    });
    assert.ok(flow.events.some((event) => event.type === "transcriptDone" && event.text === transcript));
    await flow.voice.stop(started.token);
    assert.equal(flow.voice.status().type, "idle");
    assert.throws(() => {
      flow.voice.append(started.token, {});
    }, /Realtime has stopped/);
    const reloaded = new OpenAIVoiceSession(flow.owner);
    const saved = await reloaded.transcripts();

    assert.equal(saved.length, 2);
    assert.equal(saved[0].text, transcript);
    assert.equal(saved[0].handoff, "sent");
    assert.equal(flow.handoffs.length, 1);
    const next = await flow.voice.start(flow.endpoint);

    assert.notEqual(next.token, started.token);
    assert.throws(() => {
      flow.voice.append(started.token, {});
    }, /Realtime has stopped/);
    await flow.voice.stop(next.token);
    assert.equal(flow.handoffs.length, 1);
  } finally {
    await flow.close();
  }
});

void test("OpenAI voice rejects generated rewrites and stale handoffs without executing tool work", async () => {
  const flow = await openAIVoiceFixture();

  try {
    await flow.voice.start(flow.endpoint);
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "speech-1",
      transcript: "Fix interruptions.",
    });
    await until(() => flow.frames.some((event) => event.type === "response.create"));
    flow.emit(
      completed({
        type: "response.function_call_arguments.done",
        name: "handoff_to_pocket",
        call_id: "bad-call",
        arguments: JSON.stringify({ item_id: "speech-1", instructions: "Investigate CI and long history instead." }),
      })
    );
    await until(() => flow.voice.status().type === "idle");
    assert.equal(flow.handoffs.length, 0);
    const saved = await flow.voice.transcripts();

    assert.equal(saved[0].text, "Fix interruptions.");
    assert.equal(saved[0].handoff, undefined);
    await flow.voice.start(flow.endpoint);
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "speech-2",
      transcript: "Fix switching.",
    });
    await until(() => flow.events.some((event) => event.type === "transcriptDone" && event.itemId === "speech-2"));
    flow.emit(
      completed({
        type: "response.function_call_arguments.done",
        name: "handoff_to_pocket",
        call_id: "stale-call",
        arguments: JSON.stringify({ item_id: "speech-1" }),
      })
    );
    await until(() => flow.voice.status().type === "idle");
    assert.equal(flow.handoffs.length, 0);
    assert.match(String(flow.voice.status().error), /its finalized turn/);
  } finally {
    await flow.close();
  }
});

void test("OpenAI voice requires a configured key and recovers from a provider disconnect", async () => {
  const flow = await openAIVoiceFixture();

  const unconfigured = new OpenAIVoiceSession({ ...flow.owner, readKey: () => Promise.resolve(null) });

  try {
    await assert.rejects(unconfigured.start(flow.endpoint), /API key in Settings/);
    assert.equal(flow.frames.length, 0);
    const first = await flow.voice.start(flow.endpoint);

    flow.emit({ type: "input_audio_buffer.speech_started", item_id: "speech-1" });
    await until(() => flow.events.some((event) => event.type === "interrupted"));
    flow.drop();
    await until(() => flow.voice.status().type === "idle");
    assert.equal(flow.voice.owns(first.token), false);
    assert.match(String(flow.voice.status().error), /disconnected/);
    const resumed = await flow.voice.start(flow.endpoint);

    assert.notEqual(resumed.token, first.token);
    await flow.voice.stop(resumed.token);
    assert.equal(flow.handoffs.length, 0);
  } finally {
    await flow.close();
  }
});

void test("OpenAI voice finalizes captured speech before switching to text mode", async () => {
  const flow = await openAIVoiceFixture();

  try {
    const started = await flow.voice.start(flow.endpoint);

    flow.voice.append(started.token, {
      data: Buffer.alloc(4800).toString("base64"),
      sampleRate: 24_000,
      numChannels: 1,
      samplesPerChannel: 2400,
    });
    await Promise.all([flow.voice.stop(started.token), flow.voice.stop(started.token)]);
    const reloaded = new OpenAIVoiceSession(flow.owner);
    const entries = await reloaded.transcripts();

    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "Final words while switching.");
    assert.equal(flow.handoffs.length, 0);
    assert.equal(flow.voice.status().type, "idle");
  } finally {
    await flow.close();
  }
});

void test("OpenAI voice keeps Settings failures private and never retries uncertain delivery on reload", async () => {
  const flow = await openAIVoiceFixture();
  const brokenSettings = new OpenAIVoiceSession({
    ...flow.owner,
    readKey: () => Promise.reject(new Error("malformed-private-fixture-key")),
  });
  const uncertain = new OpenAIVoiceSession({
    ...flow.owner,
    handoff: () => Promise.reject(new Error("delivery connection lost")),
  });

  try {
    await assert.rejects(brokenSettings.start(flow.endpoint), /Could not load realtime configuration/);
    assert.doesNotMatch(JSON.stringify(brokenSettings.status()), /malformed-private-fixture-key/);
    await uncertain.start(flow.endpoint);
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "speech-uncertain",
      transcript: "Check voice switching.",
    });
    await until(() => flow.frames.some((event) => event.type === "response.create"));
    flow.emit(
      completed({
        type: "response.function_call_arguments.done",
        name: "handoff_to_pocket",
        call_id: "uncertain-call",
        arguments: JSON.stringify({ item_id: "speech-uncertain" }),
      })
    );
    await until(() => uncertain.status().type === "idle");
    const reloaded = new OpenAIVoiceSession(flow.owner);
    const saved = await reloaded.transcripts();

    assert.equal(saved[0].text, "Check voice switching.");
    assert.equal(saved[0].handoff, "unknown");
    assert.equal(flow.handoffs.length, 0);
  } finally {
    uncertain.disconnect("Fixture finished.");
    await flow.close();
  }
});

void test("OpenAI voice interruption cannot execute a cancelled function response", async () => {
  const flow = await openAIVoiceFixture();

  try {
    const started = await flow.voice.start(flow.endpoint);

    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "cancelled-speech",
      transcript: "An interrupted request.",
    });
    await until(() => flow.frames.some((event) => event.type === "response.create"));
    const call = {
      type: "response.function_call_arguments.done",
      name: "handoff_to_pocket",
      call_id: "cancelled-call",
      arguments: JSON.stringify({ item_id: "cancelled-speech" }),
    };
    const response = completed(call);

    response.response.status = "cancelled";
    flow.emit(call);
    flow.emit(response);
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "corrected-speech",
      transcript: "Keep this corrected spoken intent.",
    });
    await until(() => flow.frames.filter((event) => event.type === "response.create").length === 2);
    assert.equal(flow.handoffs.length, 0);
    flow.emit(
      completed({
        name: "handoff_to_pocket",
        call_id: "corrected-call",
        arguments: JSON.stringify({ item_id: "cancelled-speech" }),
      })
    );
    await until(() => flow.handoffs.length === 1);
    assert.equal(flow.handoffs[0].transcript, "An interrupted request.\nKeep this corrected spoken intent.");
    await flow.voice.stop(started.token);
    const saved = await flow.voice.transcripts();

    assert.equal(saved[0].handoff, "sent");
    assert.equal(saved[1].handoff, "sent");
  } finally {
    await flow.close();
  }
});
