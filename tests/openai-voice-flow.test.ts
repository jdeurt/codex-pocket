/* eslint-disable jsdoc/require-param, jsdoc/require-returns, @typescript-eslint/no-magic-numbers -- These business flows exercise real local WebSocket and private-state persistence boundaries. */
import { type Data, dataSchema } from "../src/lib/protocol";
import { OpenAIVoiceSession } from "../src/server/openai-voice-session";
import { type VoiceSessionOwner } from "../src/server/voice-session-owner";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { type VoiceHandoff } from "../src/lib/voice-history";
import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";

/**
Await the externally observable boundary rather than the implementation's private queue.
*/
async function until(isComplete: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await isComplete()) {
      return;
    }

    await pause(10);
  }

  assert.fail("Voice business-flow condition did not complete.");
}

/**
Decode the fixture's actual WebSocket frames.
*/
function decode(raw: RawData) {
  const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;

  return dataSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/**
Run a provider simulator and an isolated main-session delivery boundary with a configured dummy key.
*/
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-openai-voice-"));
  const previous = process.env.CODEX_POCKET_STATE_DIR;

  process.env.CODEX_POCKET_STATE_DIR = directory;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const frames: Data[] = [];
  const handoffs: VoiceHandoff[] = [];
  const events: Data[] = [];

  let socket: WebSocket | undefined;
  let authorization = "";

  server.on("connection", (peer, request) => {
    socket = peer;
    authorization = request.headers.authorization ?? "";
    peer.on("message", (raw) => {
      const event = decode(raw);

      frames.push(event);

      if (event.type === "session.update") {
        peer.send(JSON.stringify({ type: "session.updated", session: { id: "provider-session" } }));
      } else if (event.type === "input_audio_buffer.commit") {
        peer.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "tail-speech" }));
        peer.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "tail-speech",
            transcript: "Final words while switching.",
          })
        );
      }
    });
  });
  await once(server, "listening");
  const address = server.address();

  assert.ok(address && typeof address === "object");
  const endpoint = `ws://127.0.0.1:${String(address.port)}/v1/realtime`;
  const owner: VoiceSessionOwner = {
    threadId: () => "voice-flow-main",
    readKey: () => Promise.resolve("dummy-openai-key-for-local-fixture"),
    preferences: () => Promise.resolve({ voice: "marin", model: "gpt-realtime-2.1" }),
    handoff: (input) => {
      handoffs.push(input);

      return Promise.resolve({ status: "sent" });
    },
  };
  const voice = new OpenAIVoiceSession(owner);

  voice.addEventListener("message", (event) => {
    if (event instanceof CustomEvent) {
      events.push(dataSchema.parse(event.detail));
    }
  });

  return {
    voice,
    owner,
    frames,
    handoffs,
    events,
    endpoint,
    auth: () => authorization,
    emit: (event: Data) => socket?.send(JSON.stringify(event)),
    drop: () => socket?.terminate(),
    async close() {
      voice.disconnect("Fixture finished.");

      for (const client of server.clients) {
        client.terminate();
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      if (previous === undefined) {
        delete process.env.CODEX_POCKET_STATE_DIR;
      } else {
        process.env.CODEX_POCKET_STATE_DIR = previous;
      }

      await rm(directory, { recursive: true, force: true });
    },
  };
}

void test("OpenAI voice preserves finalized speech, XML and handoff identity through text mode and reload", async () => {
  const flow = await fixture();

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
    await until(() => flow.events.some((event) => event.type === "audio"));
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
  const flow = await fixture();

  try {
    await flow.voice.start(flow.endpoint);
    flow.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "speech-1",
      transcript: "Fix interruptions.",
    });
    await until(() => flow.frames.some((event) => event.type === "response.create"));
    flow.emit({
      type: "response.function_call_arguments.done",
      name: "handoff_to_pocket",
      call_id: "bad-call",
      arguments: JSON.stringify({ item_id: "speech-1", instructions: "Investigate CI and long history instead." }),
    });
    await until(() => flow.voice.status().type === "idle");
    assert.equal(flow.handoffs.length, 0);
    const saved = await flow.voice.transcripts();

    assert.equal(saved[0].text, "Fix interruptions.");
    assert.equal(saved[0].handoff, undefined);
  } finally {
    await flow.close();
  }
});

void test("OpenAI voice requires a configured key and recovers from a provider disconnect", async () => {
  const flow = await fixture();

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
  const flow = await fixture();

  try {
    const started = await flow.voice.start(flow.endpoint);

    flow.voice.append(started.token, {
      data: Buffer.alloc(4800).toString("base64"),
      sampleRate: 24_000,
      numChannels: 1,
      samplesPerChannel: 2400,
    });
    await flow.voice.stop(started.token);
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
