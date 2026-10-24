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

/** Emit one native transcript fragment without invented turn-complete events.
@param peer - Attached metadata connection.
@param role - Native transcript lane.
@param text - Exact observed text.
@param start - Media time.
*/
function caption(peer: WebSocket, role: "input" | "output", text: string, start: number) {
  if (text) {
    emit(peer, {
      type: `session.${role}_transcript.delta`,
      event_id: crypto.randomUUID(),
      delta: text,
      start_ms: start,
      end_ms: start + 100,
    });
  }
}

/** Finish a streaming display group without scheduling or delaying media.
@param peer - Native sideband.
@param text - Remaining exact text.
@param start - Fragment media time.
*/
function finishReply(peer: WebSocket, text: string, start: number) {
  caption(peer, "output", text, start);
}

const clocks = new WeakMap<WebSocket, number>();

function reply(peer: WebSocket) {
  const options = control();
  const text = string(options.replyText) || "Hello from realtime.";
  const partial = string(options.partialReplyText) || text;
  const start = (clocks.get(peer) ?? 0) + 500;

  caption(peer, "output", partial, start);
  setTimeout(finishReply, Number(options.replyDelayMs ?? 0), peer, text.slice(partial.length), start + 100);
}

function speech(peer: WebSocket) {
  const options = control();

  const mediaClock = (clocks.get(peer) ?? 0) + 10_000;

  clocks.set(peer, mediaClock);

  if (!options.missingFinal) {
    setTimeout(
      caption,
      Number(options.finalDelayMs ?? 0),
      peer,
      "input",
      string(options.transcript) || "Test voice",
      mediaClock
    );
  }

  if (options.handoff || options.backendToolUntilSteer) {
    emit(peer, {
      type: "session.delegation.created",
      offset_ms: mediaClock + 100,
      delegation: { id: crypto.randomUUID(), type: "delegation", target: "client" },
    });
  } else {
    reply(peer);
  }
}

const answered = new WeakMap<WebSocket, Set<string>>();

function receive(peer: WebSocket, raw: RawData) {
  const event = decode(raw);

  record({ method: "provider/realtime/control", ...event });

  if (event.type === "session.close") {
    record({ method: "provider/realtime/stop" });
    emit(peer, { type: "session.closed", usage: { seconds: 1 }, reason: "client_close" });

    return;
  }

  if (event.type === "session.commentary.append") {
    const ids = answered.get(peer) ?? new Set<string>();
    const id = string(event.delegation_id);

    emit(peer, { type: "session.commentary.appended", client_event_id: event.event_id });

    if (!ids.has(id)) {
      ids.add(id);
      answered.set(peer, ids);
      reply(peer);
    }

    return;
  }

  throw new Error(`Unexpected control frame ${String(event.type)}`);
}

function connected(peer: WebSocket) {
  peer.on("message", receive.bind(undefined, peer));
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

    if (request.url !== "/v1/live/sessions") {
      failures.push(`Unexpected HTTP route ${String(request.url)}`);
      response.writeHead(404).end();

      return;
    }

    const { session } = await readRealtimeOffer(request);

    record({ method: "provider/realtime/start", session });
    response.writeHead(201, { "Content-Type": "application/json" });
    const answerSdp = string(control().answerSdp) || "v=0\r\ns=API fixture answer\r\n";

    response.end(
      JSON.stringify({
        session: { id: `live_${crypto.randomUUID()}` },
        transport: { type: "webrtc", sdp: answerSdp },
      })
    );
  });
  server.on("connection", connected.bind(undefined));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();

  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind.");
  }

  const url = `http://127.0.0.1:${String(address.port)}/v1/live`;

  writeFileSync(path.join(directory, "provider-url"), url);

  return { server, http, failures, url };
}
