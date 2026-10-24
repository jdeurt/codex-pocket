import { readRealtimeOffer, serveRealtimeHttp } from "./realtime-http";
/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers -- Synthetic provider emits explicit HTTP and WebSocket protocol envelopes. */
import { type Data, dataSchema, string } from "../../src/lib/protocol";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
import path from "node:path";

const directory = path.resolve(".local/realtime-fixture");

function control() {
  const text = readFileSync(path.join(directory, "control.json"), "utf8");

  return dataSchema.parse(JSON.parse(text));
}

function decode(raw: RawData) {
  const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;

  return dataSchema.parse(JSON.parse(bytes.toString("utf8")));
}

function record(event: Data) {
  appendFileSync(path.join(directory, "provider.jsonl"), JSON.stringify(event) + "\n");
}

function emit(peer: WebSocket, event: Data) {
  if (peer.readyState === peer.OPEN) {
    peer.send(JSON.stringify(event));
  }
}

function reply(peer: WebSocket) {
  const options = control();
  const responseId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const text = string(options.replyText) || "Hello from realtime.";

  emit(peer, { type: "response.created", response: { id: responseId } });
  emit(peer, { type: "response.output_item.added", item: { id: itemId, type: "message", role: "assistant" } });
  emit(peer, { type: "response.output_audio_transcript.delta", response_id: responseId, item_id: itemId, delta: text });
  emit(peer, {
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    item_id: itemId,
    transcript: text,
  });
  emit(peer, { type: "response.done", response: { id: responseId, status: "completed", output: [] } });
}

function speech(peer: WebSocket) {
  const options = control();
  const itemId = crypto.randomUUID();
  const responseId = crypto.randomUUID();

  emit(peer, { type: "input_audio_buffer.speech_started", item_id: itemId });
  emit(peer, { type: "input_audio_buffer.speech_stopped", item_id: itemId });
  emit(peer, { type: "input_audio_buffer.committed", item_id: itemId });

  if (!options.missingFinal) {
    setTimeout(
      () => {
        emit(peer, {
          type: "conversation.item.input_audio_transcription.completed",
          item_id: itemId,
          transcript: string(options.transcript) || "Test voice",
        });
      },
      Number(options.finalDelayMs ?? 0)
    );
  }

  if (options.handoff || options.backendToolUntilSteer) {
    const callId = crypto.randomUUID();
    const call = {
      type: "function_call",
      name: "handoff_to_pocket",
      call_id: callId,
      arguments: JSON.stringify({ request: string(options.request) || "Inspect the audio transport." }),
    };

    emit(peer, { type: "response.created", response: { id: responseId } });
    emit(peer, { type: "response.done", response: { id: responseId, status: "completed", output: [call] } });
  } else {
    reply(peer);
  }
}

export async function realtimeProvider() {
  const failures: string[] = [];
  const http = createServer();
  const server = new WebSocketServer({ server: http });

  serveRealtimeHttp(http, failures, async (request, response) => {
    if (request.url?.endsWith("/hangup")) {
      record({ method: "provider/realtime/stop" });
      response.writeHead(200).end();

      return;
    }

    if (request.url === "/test/speech" || request.url === "/test/disconnect") {
      for (const peer of server.clients) {
        if (request.url === "/test/disconnect") {
          peer.terminate();
        } else {
          speech(peer);
        }
      }

      response.writeHead(200).end();

      return;
    }

    if (request.url !== "/v1/realtime/calls") {
      failures.push(`Unexpected HTTP route ${String(request.url)}`);
      response.writeHead(404).end();

      return;
    }

    const { session } = await readRealtimeOffer(request);

    record({ method: "provider/realtime/start", session });
    response.writeHead(201, { Location: `/v1/realtime/calls/rtc_${crypto.randomUUID()}` });
    response.end(string(control().answerSdp) || "v=0\r\ns=API fixture answer\r\n");
  });
  server.on("connection", (peer) => {
    peer.on("message", (raw) => {
      const event = decode(raw);

      record({ method: "provider/realtime/control", ...event });

      switch (event.type) {
        case "session.update": {
          emit(peer, { type: "session.updated", session: { id: crypto.randomUUID() } });
          break;
        }

        case "conversation.item.create": {
          break;
        }

        case "response.create": {
          reply(peer);
          break;
        }

        default: {
          failures.push(`Unexpected control frame ${String(event.type)}`);
          peer.close();
        }
      }
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();

  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind.");
  }

  const url = `http://127.0.0.1:${String(address.port)}/v1/realtime`;

  writeFileSync(path.join(directory, "provider-url"), url);

  return { server, http, failures, url };
}
