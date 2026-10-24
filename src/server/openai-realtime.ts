/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- Transport methods share one authenticated call owner. */
import { type Data, dataSchema, object, string } from "../lib/protocol";
import WebSocket, { type RawData } from "ws";
import { configuration, REALTIME_MODEL } from "./realtime-configuration";

export { REALTIME_MODEL, REALTIME_VOICES } from "./realtime-configuration";

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_EVENT_BYTES = 1_000_000;
const MAX_CONTROL_BYTES = 128_000;
const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const LAST = -1;
const HTTP_NOT_FOUND = 404;
const SOCKET_URL = "wss://api.openai.com/v1/realtime";

/**
Decode control events without interpreting media frames.
*/
function decode(raw: RawData) {
  const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;

  return dataSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/**
Create a WebRTC call and own only its server control connection. Audio bypasses Pocket.
*/
export class OpenAIRealtime {
  private socket?: WebSocket;
  private stopped = false;
  private callId?: string;
  private key?: string;
  private callsUrl = CALLS_URL;
  private closing?: Promise<void>;

  /**
  Bind the session's control event consumer.
  */
  constructor(private receive: (event: Data) => void) {}

  /**
  Confirm server control ownership before returning the browser's SDP answer.
  */
  private attach(url: URL, key: string, voice: string, context: string) {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      maxPayload: MAX_EVENT_BYTES,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });

    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const message = "OpenAI Realtime did not confirm its control connection.";

        reject(new Error(message));
        this.receive({ type: "error", error: { message } });
      }, CONNECT_TIMEOUT_MS);

      const fail = (message: string) => {
        clearTimeout(timer);
        reject(new Error(message));

        if (!this.stopped) {
          this.receive({ type: "error", error: { message } });
        }
      };

      socket.on("open", () => {
        socket.send(JSON.stringify(configuration(voice, context)));
      });
      socket.on("message", (raw) => {
        if (this.stopped) {
          return;
        }

        let event: Data;

        try {
          event = decode(raw);
        } catch {
          fail("OpenAI Realtime returned an invalid control event.");

          return;
        }

        if (event.type === "session.updated") {
          clearTimeout(timer);
          resolve();
        } else if (event.type === "error") {
          const code = string(object(event.error).code).replaceAll(/[^a-z_]/g, "");

          fail(`OpenAI Realtime failed${code ? ` (${code})` : ""}. Start voice again to continue.`);

          return;
        }

        this.receive(event);
      });
      socket.on("error", () => {
        fail("OpenAI Realtime control connection failed.");
      });
      socket.on("close", () => {
        clearTimeout(timer);
        reject(new Error("OpenAI Realtime control connection closed."));

        if (!this.stopped) {
          this.receive({ type: "closed" });
        }
      });
    });
  }

  /**
  End the provider call, including a call created after local cancellation.
  */
  private async hangup() {
    if (!this.callId || !this.key) {
      return;
    }

    const response = await fetch(`${this.callsUrl}/${this.callId}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== HTTP_NOT_FOUND) {
      throw new Error("Realtime call closure could not be confirmed.");
    }
  }

  /**
  Negotiate SDP with OpenAI, then attach server tools before the browser starts sending media.
  */
  async connect(key: string, voice: string, sdp: string, model = REALTIME_MODEL, endpoint?: string, context = "") {
    this.key = key;
    this.callsUrl = endpoint ? new URL("/v1/realtime/calls", endpoint).href : CALLS_URL;
    const body = new FormData();

    body.set("sdp", sdp);
    body.set("session", JSON.stringify({ ...configuration(voice, context).session, model }));
    const response = await fetch(this.callsUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`OpenAI Realtime call failed (HTTP ${String(response.status)}). Check Settings and try again.`);
    }

    const location = response.headers.get("location");
    const callId = location?.split("/").at(LAST);

    if (!callId || !/^[\w-]+$/.test(callId)) {
      throw new Error("OpenAI Realtime did not return a call identity.");
    }

    this.callId = callId;
    const answer = await response.text();

    if (this.stopped) {
      await this.hangup();
      throw new Error("Realtime stopped while connecting.");
    }

    const url = new URL(endpoint ?? SOCKET_URL);

    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("call_id", callId);
    await this.attach(url, key, voice, context);

    return answer;
  }

  /**
  Send tool results and session controls; microphone and playback never use this socket.
  */
  send(event: Data) {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime has stopped.");
    }

    const encoded = JSON.stringify(event);

    if (this.socket.bufferedAmount + Buffer.byteLength(encoded) > MAX_CONTROL_BYTES) {
      throw new Error("Realtime control connection is too slow.");
    }

    this.socket.send(encoded);
  }

  /**
  Revoke controls immediately and release the provider's media session once.
  */
  close() {
    this.stopped = true;
    this.socket?.terminate();
    this.closing ??= this.hangup();

    return this.closing;
  }
}
