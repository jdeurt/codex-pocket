import { t } from "try";
import { type Data, object, string } from "../lib/protocol";
import { RealtimeControl, REALTIME_TIMEOUT_MS } from "./realtime-control";
import { configuration, REALTIME_MODEL } from "../state/realtime-configuration";

export { REALTIME_MODEL, REALTIME_VOICES } from "../state/realtime-configuration";

const SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const HTTP_NOT_FOUND = 404;
const MAX_SESSION_ID_LENGTH = 512;

/**
Create GPT-Live WebRTC sessions and own their server-side metadata connection.
*/
export class OpenAIRealtime {
  private control?: RealtimeControl;
  private stopped = false;
  private sessionId?: string;
  private key?: string;
  private sessionsUrl = SESSIONS_URL;
  private closing?: Promise<void>;

  /** Bind one application's private delegation and caption consumer.
  @param receive - Session-scoped provider event consumer.
  */
  constructor(private receive: (event: Data) => void) {}

  /**
  End a created session when sideband attachment or finalization fails.
  */
  private async hangup() {
    if (!this.sessionId || !this.key) {
      return;
    }

    const response = await fetch(`${this.sessionsUrl}/${encodeURIComponent(this.sessionId)}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== HTTP_NOT_FOUND) {
      throw new Error("GPT-Live call closure could not be confirmed.");
    }
  }

  /**
  Preserve incomplete-finalization errors while attempting an emergency provider hangup.
  */
  private async finish() {
    if (!this.control) {
      await this.hangup();

      return;
    }

    const finalized = await t(this.control.close.bind(this.control));

    if (finalized.ok) {
      return;
    }

    const hungUp = await t(this.hangup.bind(this));

    throw hungUp.ok
      ? finalized.error
      : new AggregateError([finalized.error, hungUp.error], "GPT-Live shutdown failed.");
  }

  /** Negotiate JSON session creation, preserving the provider's opaque session identity.
  @param key - Private project credential.
  @param voice - Selected voice.
  @param sdp - Fully gathered browser offer.
  @param model - GPT-Live model override or current default.
  @param endpoint - Authorized loopback fixture base, when supplied.
  @param context - Historical conversation data supplied once at creation.
  @returns Native provider SDP answer after the sideband is attached.
  */
  async connect(key: string, voice: string, sdp: string, model = REALTIME_MODEL, endpoint?: string, context = "") {
    this.key = key;
    this.sessionsUrl = endpoint ? new URL("/v1/live/sessions", endpoint).href : SESSIONS_URL;
    const response = await fetch(this.sessionsUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session: configuration(voice, context, model), transport: { type: "webrtc", sdp } }),
      signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`GPT-Live session failed (HTTP ${String(response.status)}). Check Settings and try again.`);
    }

    const result = object(await response.json());
    const id = string(object(result.session).id);
    const answer = string(object(result.transport).sdp);

    this.sessionId = id.length > MAX_SESSION_ID_LENGTH ? undefined : id;

    if (!answer || !this.sessionId) {
      throw new Error("GPT-Live did not return a session identity and SDP answer.");
    }

    if (this.stopped) {
      await this.hangup();
      throw new Error("Live voice stopped while connecting.");
    }

    const url = new URL(`${this.sessionsUrl}/${encodeURIComponent(id)}/attach`);

    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    this.control = new RealtimeControl(url, key, this.receive);
    await this.control.ready;

    return answer;
  }

  /** Send private application controls independently of the WebRTC media track.
  @param event - GPT-Live command.
  */
  send(event: Data) {
    if (this.stopped || !this.control) {
      throw new Error("Live voice has stopped.");
    }

    this.control.send(event);
  }

  /** Stop submitting commands and finalize the provider session once.
  @returns Remote finalization, preserving failure when confirmation is unavailable.
  */
  close() {
    this.stopped = true;
    this.closing ??= this.finish();

    return this.closing;
  }
}
