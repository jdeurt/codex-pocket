import WebSocket, { type RawData } from "ws";
import { t } from "try";
import { type Data, dataSchema, object, string } from "../lib/protocol";
import { configuration } from "./realtime-configuration";
import { log } from "./logging";

export const REALTIME_TIMEOUT_MS = 15_000;
const MAX_EVENT_BYTES = 1_000_000;
const MAX_CONTROL_BYTES = 128_000;

/** Decode provider control events without interpreting media.
@param raw - Complete native control frame.
@returns Validated provider event.
*/
function decode(raw: RawData) {
  const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;

  return dataSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/**
Own one authenticated provider control socket; native WebRTC owns all audio.
*/
export class RealtimeControl {
  private readonly socket;
  private readonly timer;
  private readonly confirmation = Promise.withResolvers<undefined>();
  private stopped = false;

  /**
  Apply session behavior after the native socket opens.
  */
  private opened = () => {
    const sent = t(this.send.bind(this), configuration(this.voice, this.context));

    if (!sent.ok) {
      this.fail("OpenAI Realtime control connection failed.", sent.error);
    }
  };

  /**
  Enforce the bounded provider session confirmation deadline.
  */
  private expired = () => {
    this.fail("OpenAI Realtime did not confirm its control connection.");
  };

  /** Forward a native connection failure while retaining its diagnostics.
  @param error - Native socket failure.
  */
  private failed = (error: Error) => {
    this.fail("OpenAI Realtime control connection failed.", error);
  };

  /**
  Resolve control shutdown without keeping a pending session timer alive.
  */
  private closed = () => {
    clearTimeout(this.timer);
    this.confirmation.reject(new Error("OpenAI Realtime control connection closed."));

    if (!this.stopped) {
      this.receive({ type: "closed" });
    }
  };

  /** Validate and deliver one provider control event.
  @param raw - Complete native control frame.
  */
  private message = (raw: RawData) => {
    if (this.stopped) {
      return;
    }

    const decoded = t(decode, raw);

    if (!decoded.ok) {
      this.fail("OpenAI Realtime returned an invalid control event.", decoded.error);

      return;
    }

    const event = decoded.value;

    if (event.type === "session.updated") {
      clearTimeout(this.timer);
      this.confirmation.resolve(undefined);
    } else if (event.type === "error") {
      const code = string(object(event.error).code).replaceAll(/[^a-z_]/g, "");

      this.fail(`OpenAI Realtime failed${code ? ` (${code})` : ""}. Start voice again to continue.`);

      return;
    }

    this.receive(event);
  };

  /** Acquire the provider control socket and confirmation timer.
  @param url - Provider control URL for this call.
  @param key - Private provider credential.
  @param voice - Configured provider voice.
  @param context - Explicit startup conversation context.
  @param receive - Owning session's event consumer.
  */
  constructor(
    url: URL,
    key: string,
    private readonly voice: string,
    private readonly context: string,
    private readonly receive: (event: Data) => void
  ) {
    this.socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      maxPayload: MAX_EVENT_BYTES,
      handshakeTimeout: REALTIME_TIMEOUT_MS,
    });
    this.timer = setTimeout(this.expired, REALTIME_TIMEOUT_MS);
    this.socket.on("open", this.opened);
    this.socket.on("message", this.message);
    this.socket.on("error", this.failed);
    this.socket.on("close", this.closed);
  }

  /** Reject pending startup and notify an active session about a control failure.
  @param message - User-facing connection failure.
  @param cause - Original native failure when available.
  */
  private fail(message: string, cause?: unknown) {
    clearTimeout(this.timer);
    this.confirmation.reject(new Error(message, { cause }));

    if (cause) {
      log().warn({ error: cause }, "realtime.control_failed");
    }

    if (!this.stopped) {
      this.receive({ type: "error", error: { message } });
    }
  }

  /** Expose provider acknowledgement of session configuration.
  @returns Completion of provider control setup.
  */
  get ready() {
    return this.confirmation.promise;
  }

  /** Send a bounded tool or session event over the control connection.
  @param event - Provider control event, never media.
  */
  send(event: Data) {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime has stopped.");
    }

    const encoded = JSON.stringify(event);

    if (this.socket.bufferedAmount + Buffer.byteLength(encoded) > MAX_CONTROL_BYTES) {
      throw new Error("Realtime control connection is too slow.");
    }

    this.socket.send(encoded);
  }

  /**
  Revoke controls and release this socket's timer and connection.
  */
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket.terminate();
  }
}
