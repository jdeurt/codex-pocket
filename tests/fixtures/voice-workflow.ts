import { readRealtimeOffer, serveRealtimeHttp } from "./realtime-http";
import { type Data, dataSchema } from "../../src/lib/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { type TestContext } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { workflowBridge } from "./workflow-bridge";
import { nativeWorkspace } from "./workflow";
import { updatePocketSettings } from "../../src/server/pocket-settings";
import assert from "node:assert/strict";
import { once } from "node:events";

const LAST = -1;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const ATTACH_PATH = /^\/v1\/live\/sessions\/live_[^/]+\/attach$/;
export const TEST_SDP = "v=0\r\ns=Pocket test offer\r\n";

interface Provider {
  frames: Data[];
  events: Data[];
  calls: Data[];
  peers: WebSocket[];
  failures: string[];
  shouldFinalize: boolean;
}

/** Decode real control frames exchanged with the loopback provider.
@param raw - Received WebSocket frame.
@returns Parsed provider control event.
*/
function decode(raw: RawData) {
  const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const text = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString();

  return dataSchema.parse(JSON.parse(text));
}

/** Create actual JSON Live sessions, independently of the application's encoder.
@param provider - Test observations.
@param request - Native HTTP request.
@param response - Native HTTP response.
*/
async function handle(provider: Provider, request: IncomingMessage, response: ServerResponse) {
  assert.equal(request.headers.authorization, "Bearer synthetic-voice-workflow-key");

  if (request.url?.endsWith("/hangup")) {
    provider.calls.push({ action: "hangup", url: request.url });
    response.writeHead(HTTP_OK).end();

    return;
  }

  assert.equal(request.url, "/v1/live/sessions");
  const { sdp, session } = await readRealtimeOffer(request);

  provider.calls.push({ action: "start", sdp, session });
  response.writeHead(HTTP_CREATED, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({ session: { id: `live_${crypto.randomUUID()}` }, transport: { type: "webrtc", sdp: TEST_SDP } })
  );
}

/** Receive context appends and finalize only when the test permits it.
@param provider - Test observations and shutdown gate.
@param socket - Attached sideband.
@param raw - Native control frame.
*/
function received(provider: Provider, socket: WebSocket, raw: RawData) {
  const event = decode(raw);

  provider.frames.push(event);

  if (event.type === "session.close") {
    if (provider.shouldFinalize) {
      socket.send(JSON.stringify({ type: "session.closed", usage: { seconds: 1 }, reason: "client_close" }));
    }

    return;
  }

  if (event.type === "session.commentary.append" || event.type === "session.thinking.append") {
    socket.send(JSON.stringify({ type: `${event.type}ed`, client_event_id: event.event_id }));

    return;
  }

  provider.failures.push(`Unexpected provider control: ${String(event.type)}`);
}

/** Authenticate an existing-session sideband without expecting any startup command.
@param provider - Test observations.
@param socket - Native WebSocket.
@param request - Native upgrade request.
*/
function connected(provider: Provider, socket: WebSocket, request: IncomingMessage) {
  assert.equal(request.headers.authorization, "Bearer synthetic-voice-workflow-key");
  assert.match(request.url ?? "", ATTACH_PATH);
  provider.peers.push(socket);
  socket.on("message", received.bind(undefined, provider, socket));
}

/** Send metadata through the latest native provider sideband.
@param provider - Test observations.
@param event - Provider event.
*/
function emit(provider: Provider, event: Data) {
  const socket = provider.peers.at(LAST);

  assert.ok(socket);
  socket.send(JSON.stringify(event));
}

/** Emit an immutable native caption fragment with explicit media timing.
@param provider - Test observations.
@param id - Native event identity.
@param text - Exact observed text.
@param role - Speaker.
@param start - Media start time.
@param end - Media end time.
*/
function speech(provider: Provider, id: string, text: string, role = "user", start = 0, end = start + 1) {
  emit(provider, {
    type: `session.${role === "user" ? "input" : "output"}_transcript.delta`,
    event_id: id,
    delta: text,
    start_ms: start,
    end_ms: end,
  });
}

/** Emit delegation metadata without inventing provider task arguments.
@param provider - Test observations.
@param id - Native delegation identity.
@param offset - Native media timestamp.
*/
function delegation(provider: Provider, id: string, offset = 0) {
  emit(provider, {
    type: "session.delegation.created",
    offset_ms: offset,
    delegation: { id, type: "delegation", target: "client" },
  });
}

/** Collect application caption frames independently of persistence.
@param provider - Test observations.
@param event - Application transport event.
*/
function observed(provider: Provider, event: Event) {
  if (event instanceof CustomEvent) {
    provider.events.push(dataSchema.parse(event.detail));
  }
}

/** Release all fixture resources and report unexpected protocol commands.
@param bridge - Main application runtime.
@param server - Sideband fixture.
@param http - Provider HTTP fixture.
@param provider - Captured protocol failures.
*/
function cleanup(
  bridge: ReturnType<typeof workflowBridge>,
  server: WebSocketServer,
  http: ReturnType<typeof createServer>,
  provider: Provider
) {
  bridge.close();

  for (const socket of server.clients) {
    socket.terminate();
  }

  server.close();
  http.closeAllConnections();
  http.close();
  assert.deepEqual(provider.failures, []);
}

/** Exercise native Live controls, the actual main bridge and durable history.
@param t - Test owning all native processes and connections.
@param scenario - Optional native agent scenario.
@returns Live application session and synthetic provider controls.
*/
export async function voiceWorkflow(t: TestContext, scenario?: Data) {
  const fixture = await nativeWorkspace(t, scenario ?? { turn: { chunks: ["Voice repair completed."] } });
  const provider: Provider = { frames: [], events: [], calls: [], peers: [], failures: [], shouldFinalize: true };
  const http = createServer();

  serveRealtimeHttp(http, provider.failures, handle.bind(undefined, provider));
  const server = new WebSocketServer({ server: http });

  server.on("connection", connected.bind(undefined, provider));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();

  assert.ok(address && typeof address === "object");
  fixture.environment({ POCKET_REALTIME_TEST_URL: `http://127.0.0.1:${String(address.port)}/v1/live` });
  const bridge = workflowBridge(fixture, fixture.config);

  fixture.cleanup(cleanup.bind(undefined, bridge, server, http, provider));
  bridge.realtime.addEventListener("message", observed.bind(undefined, provider));
  await updatePocketSettings({ openaiApiKey: "synthetic-voice-workflow-key" });
  await bridge.ensureConnected();

  return {
    ...fixture,
    bridge,
    voice: bridge.realtime,
    ...provider,
    provider,
    emit: emit.bind(undefined, provider),
    speech: speech.bind(undefined, provider),
    delegation: delegation.bind(undefined, provider),
  };
}
