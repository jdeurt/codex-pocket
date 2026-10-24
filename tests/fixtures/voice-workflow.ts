import { readRealtimeOffer, serveRealtimeHttp } from "./realtime-http";
import { type Data, dataSchema, object } from "../../src/lib/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { type TestContext } from "node:test";
import { createServer } from "node:http";
import { workflowBridge } from "./workflow-bridge";
import { nativeWorkspace, eventually } from "./workflow";
import { updatePocketSettings } from "../../src/server/pocket-settings";
import assert from "node:assert/strict";
import { once } from "node:events";

const LAST = -1;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
export const TEST_SDP = "v=0\r\ns=Pocket test offer\r\n";

/** Decode real control frames exchanged with the loopback provider.
@param raw - Received WebSocket frame.
@returns Parsed provider control event.
*/
function decode(raw: RawData) {
  const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const text = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString();

  return dataSchema.parse(JSON.parse(text));
}

/** Exercise call negotiation, server tools, the actual main bridge and durable history.
@param t - Test owning all native processes and connections.
@param scenario - Optional native agent scenario.
@returns Live application session and a provider that responds without waiting for transcription.
*/
export async function voiceWorkflow(t: TestContext, scenario?: Data) {
  const fixture = await nativeWorkspace(t, scenario ?? { turn: { chunks: ["Voice repair completed."] } });
  const frames: Data[] = [];
  const events: Data[] = [];
  const calls: Data[] = [];
  const peers: WebSocket[] = [];
  const responses: { socket: WebSocket; id: string; request: Data }[] = [];
  const failures: string[] = [];
  const http = createServer();

  serveRealtimeHttp(http, failures, async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-voice-workflow-key");

    if (request.url?.endsWith("/hangup")) {
      calls.push({ action: "hangup", url: request.url });
      response.writeHead(HTTP_OK).end();

      return;
    }

    assert.equal(request.url, "/v1/realtime/calls");
    const { sdp, session } = await readRealtimeOffer(request);

    calls.push({ action: "start", sdp, session });
    response.writeHead(HTTP_CREATED, { Location: `/v1/realtime/calls/rtc_${crypto.randomUUID()}` });
    response.end("v=0\r\ns=Pocket test answer\r\n");
  });
  const server = new WebSocketServer({ server: http });
  const begin = (socket: WebSocket, request: Data = {}) => {
    const captured = { socket, id: crypto.randomUUID(), request };

    responses.push(captured);
    socket.send(JSON.stringify({ type: "response.created", response: { id: captured.id } }));

    return captured;
  };

  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-voice-workflow-key");
    assert.ok(new URL(request.url ?? "", "http://localhost").searchParams.get("call_id"));
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
          begin(socket, object(event.response));
          break;
        }

        case "conversation.item.create": {
          break;
        }

        default: {
          failures.push(`Unexpected provider control: ${String(event.type)}`);
        }
      }
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();

  assert.ok(address && typeof address === "object");
  fixture.environment({ POCKET_REALTIME_TEST_URL: `http://127.0.0.1:${String(address.port)}/v1/realtime` });
  const bridge = workflowBridge(fixture, fixture.config);

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
    await new Promise<void>((resolve) =>
      http.close(() => {
        resolve();
      })
    );
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
  const speech = (id: string, transcript?: string) => {
    emit({ type: "input_audio_buffer.speech_started", item_id: id });
    emit({ type: "input_audio_buffer.speech_stopped", item_id: id });
    emit({ type: "input_audio_buffer.committed", item_id: id });
    const socket = peers.at(LAST);

    assert.ok(socket);
    begin(socket);

    if (transcript !== undefined) {
      emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript });
    }
  };
  const response = async (index: number) => {
    await eventually(() => responses.length > index, `Provider response ${String(index)} must exist`);
    const captured = responses[index];
    const send = (event: Data) => {
      captured.socket.send(JSON.stringify({ response_id: captured.id, ...event }));
    };
    const done = (functions: Data[] = [], status = "completed") => {
      send({
        type: "response.done",
        response: {
          id: captured.id,
          status,
          output: functions.map((call) => ({ type: "function_call", ...call })),
        },
      });
    };

    return { request: captured.request, send, done };
  };

  return { ...fixture, bridge, voice: bridge.realtime, events, frames, calls, peers, emit, speech, response };
}
