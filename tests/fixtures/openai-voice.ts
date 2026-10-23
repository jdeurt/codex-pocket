/* eslint-disable jsdoc/require-param, jsdoc/require-returns, @typescript-eslint/no-magic-numbers -- These business flows exercise real local WebSocket and private-state persistence boundaries. */
import { type Data, dataSchema, object } from "../../src/lib/protocol";
import { OpenAIVoiceSession } from "../../src/server/openai-voice-session";
import { type VoiceSessionOwner } from "../../src/server/voice-session-owner";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { type VoiceHandoff } from "../../src/lib/voice-history";
import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

/**
Await the externally observable boundary rather than the implementation's private queue.
*/
export async function until(isComplete: () => boolean | Promise<boolean>) {
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
export async function openAIVoiceFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-openai-voice-"));
  const previous = process.env.CODEX_POCKET_STATE_DIR;

  process.env.CODEX_POCKET_STATE_DIR = directory;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const frames: Data[] = [];
  const handoffs: VoiceHandoff[] = [];
  const events: Data[] = [];

  let socket: WebSocket | undefined;
  let authorization = "";
  let responseId = "";

  server.on("connection", (peer, request) => {
    socket = peer;
    authorization = request.headers.authorization ?? "";
    peer.on("message", (raw) => {
      const event = decode(raw);

      frames.push(event);

      switch (event.type) {
        case "session.update": {
          peer.send(JSON.stringify({ type: "session.updated", session: { id: "provider-session" } }));
          break;
        }

        case "response.create": {
          responseId = crypto.randomUUID();
          peer.send(
            JSON.stringify({
              type: "response.created",
              response: { id: responseId, metadata: object(event.response).metadata },
            })
          );
          break;
        }

        case "input_audio_buffer.commit": {
          peer.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "tail-speech" }));
          peer.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "tail-speech",
              transcript: "Final words while switching.",
            })
          );
          break;
        }
        // No default
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
    responseId: () => responseId,
    emit: (event: Data) => {
      if (event.type === "response.done") {
        const request = frames.findLast((frame) => frame.type === "response.create");

        event = { ...event, response: { metadata: object(request?.response).metadata, ...object(event.response) } };
      }

      if (event.type === "response.output_audio.delta" || event.type === "response.output_audio_transcript.done") {
        event = { response_id: responseId, ...event };
      }

      socket?.send(JSON.stringify(event));
    },
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
