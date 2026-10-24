import WebSocket, { type RawData } from "ws";
import { t } from "try";
import { type Data, dataSchema, object, string } from "../lib/protocol";
import { log } from "./logging";

export const REALTIME_TIMEOUT_MS = 15_000;
const MAX_EVENT_BYTES = 1_000_000;
const MAX_CONTROL_BYTES = 128_000;

/** Decode provider JSON without decoding or retaining reflected audio.
@param raw - Complete native sideband frame.
@returns Validated provider metadata.
*/
function decode(raw: RawData) {
  const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;

  return dataSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/**
Own an authenticated GPT-Live sideband and its bounded graceful finalization.
*/
export class RealtimeControl {
  private readonly socket;
  private readonly timer;
  private readonly confirmation = Promise.withResolvers<undefined>();
  private readonly finalization = Promise.withResolvers<Data>();
  private isFinalized = false;
  private isClosing = false;
  private stopped = false;
  private closing?: Promise<void>;

  /**
  An attached sideband already belongs to a running session; send no startup or update command.
  */
  private opened = () => {
    clearTimeout(this.timer);
    this.confirmation.resolve(undefined);
  };

  /**
  Enforce a bounded sideband connection deadline.
  */
  private expired = () => {
    this.fail("GPT-Live did not open its control connection.");
  };

  /** Forward native connection diagnostics without exposing credentials.
  @param error - Original native failure.
  */
  private failed = (error: Error) => {
    this.fail("GPT-Live control connection failed.", error);
  };

  /**
  Reject incomplete finalization when the transport closes before its final event.
  */
  private closed = () => {
    clearTimeout(this.timer);
    this.confirmation.reject(new Error("GPT-Live control connection closed."));

    if (this.isClosing && !this.isFinalized) {
      this.finalization.reject(new Error("GPT-Live finalization could not be confirmed."));
    }

    if (!this.stopped && !this.isClosing && !this.isFinalized) {
      this.receive({ type: "closed" });
    }
  };

  /**
  Bound graceful shutdown without holding microphone or speaker activity open.
  */
  private closeExpired = () => {
    this.finalization.reject(new Error("GPT-Live finalization timed out."));
  };

  /** Deliver metadata while dropping reflected audio copies immediately.
  @param raw - Native provider frame.
  */
  private message = (raw: RawData) => {
    if (this.stopped) {
      return;
    }

    const decoded = t(decode, raw);

    if (!decoded.ok) {
      this.fail("GPT-Live returned an invalid control event.", decoded.error);

      return;
    }

    const event = decoded.value;

    if (["session.input_audio.append", "session.output_audio.delta"].includes(string(event.type))) {
      return;
    }

    if (event.type === "session.closed") {
      this.isFinalized = true;
      this.finalization.resolve(event);
    } else if (event.type === "error") {
      const code = string(object(event.error).code).replaceAll(/[^a-z_]/g, "");

      this.fail(`GPT-Live failed${code ? ` (${code})` : ""}. Start voice again to continue.`);

      return;
    }

    this.receive(event);
  };

  /** Attach to the session using the same project authentication as its creation request.
  @param url - Session-specific attach URL.
  @param key - Private provider credential.
  @param receive - Owning session's event consumer.
  */
  constructor(
    url: URL,
    key: string,
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

  /** Reject startup or an in-progress close and report a call-level transport failure.
  @param message - Public failure description.
  @param cause - Native diagnostic, when available.
  */
  private fail(message: string, cause?: unknown) {
    clearTimeout(this.timer);
    this.confirmation.reject(new Error(message, { cause }));

    if (cause) {
      log().warn({ error: cause }, "live.control_failed");
    }

    if (this.isClosing) {
      this.finalization.reject(new Error(message, { cause }));
    } else if (!this.stopped) {
      this.receive({ type: "error", error: { message } });
    }
  }

  /**
  Send close once and retain the receiver until final usage has arrived.
  */
  private async finish() {
    this.isClosing = true;
    const sent = this.isFinalized ? undefined : t(this.send.bind(this), { type: "session.close" });

    if (sent && !sent.ok) {
      this.stopped = true;
      this.socket.terminate();
      throw sent.error;
    }

    const timer = setTimeout(this.closeExpired, REALTIME_TIMEOUT_MS);
    const finalized = await t(this.finalization.promise);

    clearTimeout(timer);
    clearTimeout(this.timer);
    this.stopped = true;
    this.socket.terminate();

    if (!finalized.ok) {
      throw finalized.error;
    }

    log().info({ usage: finalized.value.usage, reason: finalized.value.reason }, "live.finalized");
  }

  /** Await only the existing session's sideband attachment.
  @returns Native connection establishment.
  */
  get ready() {
    return this.confirmation.promise;
  }

  /** Send a bounded application command, never microphone audio.
  @param event - GPT-Live client command.
  */
  send(event: Data) {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Live voice has stopped.");
    }

    const encoded = JSON.stringify(event);

    if (this.socket.bufferedAmount + Buffer.byteLength(encoded) > MAX_CONTROL_BYTES) {
      throw new Error("GPT-Live control connection is too slow.");
    }

    this.socket.send(encoded);
  }

  /** Share one shutdown operation across simultaneous local and remote close requests.
  @returns Confirmation of session.closed, or an explicit incomplete-finalization failure.
  */
  close() {
    this.closing ??= this.finish();

    return this.closing;
  }
}
