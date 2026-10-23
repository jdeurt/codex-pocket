import { nativeText } from "../../src/server/harness/transcript";
import { object } from "../../src/lib/protocol";
import { voiceWorkflow } from "../fixtures/voice-workflow";
import { eventually } from "../fixtures/workflow";
import assert from "node:assert/strict";
import test from "node:test";

const PCM_SAMPLES = 2400;
const SECOND_PLAYBACK = 3;
const FRESH_PCM_BYTE = 3;
const PLAYED_MS = 50;
const handoff = { name: "handoff_to_pocket", call_id: "handoff", arguments: "{}" };

await test("new speech interrupts main-answer playback, truncates heard audio and rejects stale output across sessions", async (t) => {
  const flow = await voiceWorkflow(t);
  const started = await flow.voice.start();
  const oldPcm = Buffer.alloc(PCM_SAMPLES * 2, 2).toString("base64");
  const freshPcm = Buffer.alloc(PCM_SAMPLES * 2, FRESH_PCM_BYTE).toString("base64");

  flow.speech("original", "Inspect voice playback.");
  const original = await flow.response(0);

  original.done([handoff]);
  const playback = await flow.response(1);

  playback.send({ type: "response.output_audio.delta", item_id: "old-answer", delta: oldPcm });
  await eventually(() => flow.events.some((event) => event.type === "audio"), "The main answer must start playing");
  flow.voice.truncate(started.token, "old-answer", PLAYED_MS);
  await eventually(
    () => flow.frames.some((frame) => frame.type === "conversation.item.truncate"),
    "Heard playback must be synchronized to the provider"
  );
  assert.deepEqual(
    flow.frames.find((frame) => frame.type === "conversation.item.truncate"),
    {
      type: "conversation.item.truncate",
      item_id: "old-answer",
      content_index: 0,
      audio_end_ms: PLAYED_MS,
    }
  );
  flow.emit({ type: "input_audio_buffer.speech_started", item_id: "correction" });
  playback.send({ type: "response.output_audio.delta", item_id: "old-answer", delta: oldPcm });
  playback.send({ type: "response.output_audio_transcript.done", item_id: "old-answer", transcript: "Stale answer." });
  playback.done([], "cancelled");
  flow.speech("correction", "Inspect switching instead.", "original");
  const correction = await flow.response(2);

  playback.send({ type: "response.output_audio.delta", item_id: "old-answer", delta: oldPcm });
  playback.done();
  correction.done([{ ...handoff, call_id: "corrected-handoff" }]);
  const correctedPlayback = await flow.response(SECOND_PLAYBACK);

  correctedPlayback.send({ type: "response.output_audio.delta", item_id: "corrected-answer", delta: freshPcm });
  correctedPlayback.done();
  await eventually(
    () => flow.events.filter((event) => event.type === "audio").length === 2,
    "The new answer must play after the interruption"
  );
  await flow.voice.stop(started.token);
  const next = await flow.voice.start();

  // A late completion callback from the earlier main turn cannot speak in the new session.
  flow.voice.completed(flow.bridge.snapshot.turns[0]);
  flow.speech("fresh-session", "Hello again.");
  const greeting = await flow.response(SECOND_PLAYBACK + 1);

  assert.notEqual(greeting.request.tool_choice, "none");
  greeting.send({ type: "response.output_audio.delta", item_id: "welcome", delta: freshPcm });
  greeting.send({ type: "response.output_audio_transcript.done", item_id: "welcome", transcript: "Welcome back." });
  greeting.done();
  await eventually(
    () => flow.events.some((event) => event.type === "transcriptDone" && event.text === "Welcome back."),
    "The fresh session must finish its own response"
  );
  await flow.voice.stop(next.token);
  assert.deepEqual(
    flow.events.filter((event) => event.type === "audio").map((event) => [event.itemId, object(event.audio).data]),
    [
      ["old-answer", oldPcm],
      ["corrected-answer", freshPcm],
      ["welcome", freshPcm],
    ]
  );
  assert.deepEqual(
    flow.bridge.snapshot.turns.map((turn) => nativeText(turn.items[0].content)),
    ["Inspect voice playback.", "Inspect switching instead."]
  );
  const saved = await flow.voice.transcripts();

  assert.deepEqual(
    saved.filter((entry) => entry.role === "assistant").map((entry) => entry.text),
    ["Welcome back."]
  );
  assert.equal(saved.find((entry) => entry.itemId === "correction")?.handoff, "sent");
});
