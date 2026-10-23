import { type Data, dataSchema, object } from "../../src/lib/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { type TestContext } from "node:test";
import { Bridge } from "../../src/server/bridge-session";
import { nativeWorkspace, eventually } from "./workflow";
import { updatePocketSettings } from "../../src/server/pocket-settings";
import assert from "node:assert/strict";
import { once } from "node:events";

const LAST = -1;

/** Decode actual provider wire frames without replacing Pocket's protocol parser.
@param raw - Frame delivered over the loopback WebSocket.
@returns Validated provider event record.
*/
function decode(raw: RawData) {
  const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw;

  const text = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString();

  return dataSchema.parse(JSON.parse(text));
}

/** Run voice through Settings, the real bridge, native transport, and persisted transcripts.
@param t - Context owning every socket, transport and state directory.
@param scenario - Optional native transport fault scenario.
@returns Real app session and provider controls with immutable response identities.
*/
export async function voiceWorkflow(t: TestContext, scenario?: Data) {
  const fixture = await nativeWorkspace(t, scenario ?? { turn: { chunks: ["Voice repair completed."] } });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const frames: Data[] = [];
  const events: Data[] = [];
  const responses: { socket: WebSocket; id: string; request: Data }[] = [];
  const peers: WebSocket[] = [];
  const failures: string[] = [];

  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-voice-workflow-key");
    peers.push(socket);
    socket.on("message", (raw) => {
      const event = decode(raw);

      frames.push(event);

      switch (event.type) {
        case "session.update": {
          socket.send(JSON.stringify({ type: "session.updated", session: { id: crypto.randomUUID() } }));
          break;
        }

        case "response.create": {
          const response = { socket, id: crypto.randomUUID(), request: structuredClone(object(event.response)) };

          responses.push(response);
          socket.send(
            JSON.stringify({
              type: "response.created",
              response: { id: response.id, metadata: response.request.metadata },
            })
          );
          break;
        }

        case "input_audio_buffer.commit": {
          socket.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "trailing-speech" }));
          socket.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "trailing-speech",
              transcript: "Final words before text mode.",
            })
          );
          break;
        }

        case "input_audio_buffer.append":
        case "input_audio_buffer.clear":
        case "conversation.item.create":
        case "conversation.item.truncate":
        case "response.cancel": {
          break;
        }

        default: {
          failures.push(`Unexpected provider call: ${String(event.type)}`);
        }
      }
    });
  });
  await once(server, "listening");
  const address = server.address();

  assert.ok(address && typeof address === "object");
  fixture.environment({ POCKET_REALTIME_TEST_URL: `ws://127.0.0.1:${String(address.port)}/v1/realtime` });
  const bridge = new Bridge(fixture.config);

  fixture.cleanup(async () => {
    bridge.close();

    for (const socket of server.clients) {
      socket.terminate();
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    assert.deepEqual(failures, []);
  });
  bridge.realtime.addEventListener("message", (event) => {
    if (event instanceof CustomEvent) {
      events.push(dataSchema.parse(event.detail));
    }
  });
  await updatePocketSettings({ openaiApiKey: "synthetic-voice-workflow-key" });
  await bridge.ensureConnected();
  const emit = (event: Data) => {
    const socket = peers.at(LAST);

    assert.ok(socket);
    socket.send(JSON.stringify(event));
  };
  const speech = (id: string, transcript: string, previous?: string) => {
    emit({ type: "input_audio_buffer.committed", item_id: id, ...(previous && { previous_item_id: previous }) });
    emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript });
  };
  const response = async (index: number) => {
    await eventually(() => responses.length > index, `Provider response ${String(index)} must be requested`);
    const captured = responses[index];
    const send = (event: Data) => {
      captured.socket.send(JSON.stringify({ response_id: captured.id, ...event }));
    };
    const done = (calls: Data[] = [], status = "completed") => {
      send({
        type: "response.done",
        response: {
          id: captured.id,
          metadata: captured.request.metadata,
          status,
          output: calls.map((call) => ({ type: "function_call", ...call })),
        },
      });
    };

    return { request: captured.request, send, done };
  };

  return { ...fixture, bridge, voice: bridge.realtime, events, frames, peers, emit, speech, response };
}
