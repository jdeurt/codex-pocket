/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers -- Local provider simulator emits complete speech and handoff flows over real WebSockets. */
import { type Data, object, string } from "../../src/lib/protocol";
import { appendFileSync, readFileSync } from "node:fs";
import { type RawData, WebSocketServer } from "ws";
import path from "node:path";
import { z } from "zod";

const directory = path.resolve(".local/realtime-fixture");
const controls = z.object({
  transcript: z.string().optional(),
  handoff: z.boolean().optional(),
  duplicateHandoff: z.boolean().optional(),
  invalidHandoff: z.boolean().optional(),
  bargeIn: z.boolean().optional(),
  backendToolUntilSteer: z.boolean().optional(),
  disconnectOnAudio: z.boolean().optional(),
  deferTranscript: z.boolean().optional(),
  missingFinal: z.boolean().optional(),
  finalDelayMs: z.number().optional(),
  burstChunks: z.number().optional(),
  burstSamples: z.number().optional(),
});

function control() {
  const raw = readFileSync(path.join(directory, "control.json"), "utf8");

  return controls.parse(JSON.parse(raw));
}

function decode(raw: RawData) {
  const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;

  return object(JSON.parse(bytes.toString("utf8")));
}

function record(event: Data) {
  appendFileSync(path.join(directory, "provider.jsonl"), JSON.stringify(event) + "\n");
}

function audio(samples: number) {
  const data = Buffer.alloc(samples * 2);

  for (let index = 0; index < samples; index++) {
    data.writeInt16LE(Math.round(Math.sin((index * 2 * Math.PI * 420) / 24_000) * 7000), index * 2);
  }

  return data.toString("base64");
}

function playbackText(response: Data) {
  if (response.tool_choice !== "none") {
    return "Hello";
  }

  const input = response.input;
  const content = Array.isArray(input) ? object(input[0]).content : [];

  return Array.isArray(content) ? string(object(content[0]).text) : "";
}

export async function realtimeProvider() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  server.on("connection", (peer, request) => {
    const sessionId = crypto.randomUUID();
    const itemId = `${sessionId}-speech`;
    const emit = (event: Data) => {
      peer.send(JSON.stringify(event));
    };
    const finish = () => {
      const options = control();

      if (options.missingFinal) {
        return;
      }

      emit({ type: "input_audio_buffer.committed", item_id: itemId });
      setTimeout(() => {
        if (peer.readyState === peer.OPEN) {
          emit({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: itemId,
            transcript: options.transcript ?? "Test voice",
          });
        }
      }, options.finalDelayMs ?? 0);
    };

    let isReplied = false;
    let hasInterrupted = false;

    peer.on("message", (raw) => {
      const event = decode(raw);
      const options = control();

      switch (event.type) {
        case "session.update": {
          const output = object(object(object(event.session).audio).output);

          record({
            method: "provider/realtime/start",
            sessionId,
            model: new URL(request.url ?? "/", "http://localhost").searchParams.get("model"),
            voice: output.voice,
          });
          emit({ type: "session.updated", session: { id: sessionId } });
          break;
        }

        case "input_audio_buffer.append": {
          record({
            method: "provider/realtime/appendAudio",
            sessionId,
            sampleRate: 24_000,
            samples: Buffer.from(string(event.audio), "base64").byteLength / 2,
          });

          if (options.disconnectOnAudio) {
            peer.terminate();

            return;
          }

          if (!isReplied) {
            isReplied = true;
            emit({ type: "input_audio_buffer.speech_started", item_id: itemId });

            if (!options.deferTranscript) {
              finish();
            }
          }

          break;
        }

        case "conversation.item.truncate": {
          record({ method: "provider/realtime/truncate", ...event });
          break;
        }

        case "input_audio_buffer.commit": {
          if (options.deferTranscript) {
            finish();
          } else {
            emit({ type: "error", error: { code: "input_audio_buffer_commit_empty" } });
          }

          break;
        }

        case "response.create": {
          const output: Data[] = [];
          const responseId = crypto.randomUUID();
          const isPlayback = object(event.response).tool_choice === "none";

          record({ method: "provider/realtime/response", sessionId, response: event.response });

          emit({ type: "response.created", response: { id: responseId, metadata: object(event.response).metadata } });

          if (!hasInterrupted && options.bargeIn) {
            hasInterrupted = true;
            emit({
              type: "response.output_audio.delta",
              response_id: responseId,
              item_id: `${sessionId}-reply`,
              delta: audio(12_000),
            });
            setTimeout(() => {
              emit({ type: "input_audio_buffer.speech_started", item_id: `${itemId}-continued` });
              emit({
                type: "response.output_audio.delta",
                response_id: responseId,
                item_id: `${sessionId}-reply`,
                delta: audio(12_000),
              });
              emit({ type: "input_audio_buffer.committed", item_id: `${itemId}-continued`, previous_item_id: itemId });
              emit({
                type: "conversation.item.input_audio_transcription.completed",
                item_id: `${itemId}-continued`,
                transcript: "And preserve my follow-up.",
              });
              emit({
                type: "response.done",
                response: {
                  id: responseId,
                  status: "cancelled",
                  metadata: object(event.response).metadata,
                  output: [],
                },
              });
            }, 150);
            break;
          }

          if (!isPlayback && [options.handoff, options.backendToolUntilSteer, options.invalidHandoff].some(Boolean)) {
            const handoff = {
              type: "response.function_call_arguments.done",
              name: "handoff_to_pocket",
              call_id: `${sessionId}-call`,
              arguments: JSON.stringify(options.invalidHandoff ? { instructions: "unrelated instructions" } : {}),
            };

            emit(handoff);
            output.push({ ...handoff, type: "function_call" });

            if (options.duplicateHandoff) {
              emit({ ...handoff, call_id: `${sessionId}-duplicate` });
              output.push({ ...handoff, type: "function_call", call_id: `${sessionId}-duplicate` });
            }
          } else {
            for (let index = 0; index < (options.burstChunks ?? 1); index++) {
              emit({
                type: "response.output_audio.delta",
                response_id: responseId,
                item_id: `${sessionId}-reply`,
                delta: audio(options.burstSamples ?? 2400),
              });
            }

            emit({
              type: "response.output_audio_transcript.done",
              response_id: responseId,
              item_id: `${sessionId}-reply`,
              transcript: playbackText(object(event.response)),
            });
          }

          emit({
            type: "response.done",
            response: { status: "completed", metadata: object(event.response).metadata, output },
          });
          break;
        }
        // No default
      }
    });
    peer.on("close", () => {
      record({ method: "provider/realtime/stop", sessionId });
    });
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Local voice provider did not bind.");
  }

  return { server, url: `ws://127.0.0.1:${String(address.port)}/v1/realtime` };
}
