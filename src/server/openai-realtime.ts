import { type Data } from "../lib/protocol";
import { RealtimeControl, REALTIME_TIMEOUT_MS } from "./realtime-control";
import { configuration, REALTIME_MODEL } from "./realtime-configuration";

export { REALTIME_MODEL, REALTIME_VOICES } from "./realtime-configuration";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const LAST = -1;
const HTTP_NOT_FOUND = 404;
const SOCKET_URL = "wss://api.openai.com/v1/realtime";

/**
Create a WebRTC call and own only its server control connection. Audio bypasses Pocket.
*/
export class OpenAIRealtime {
  private control?: RealtimeControl;
  private stopped = false;
  private callId?: string;
  private key?: string;
  private callsUrl = CALLS_URL;
  private closing?: Promise<void>;

  /**
  Bind the session's control event consumer.
  @param receive - Owning session's provider event consumer.
  */
  constructor(private receive: (event: Data) => void) {}

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
      signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== HTTP_NOT_FOUND) {
      throw new Error("Realtime call closure could not be confirmed.");
    }
  }

  /**
  Negotiate SDP with OpenAI, then attach server tools before the browser starts sending media.
  @param key - Private provider credential.
  @param voice - Configured provider voice.
  @param sdp - Browser media offer.
  @param model - Configured Realtime model.
  @param endpoint - Optional test provider endpoint.
  @param context - Explicit startup conversation context.
  @returns Provider media answer after control setup succeeds.
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
      signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS),
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
    this.control = new RealtimeControl(url, key, voice, context, this.receive);
    await this.control.ready;

    return answer;
  }

  /**
  Send tool results and session controls; microphone and playback never use this socket.
  @param event - Provider control event.
  */
  send(event: Data) {
    if (this.stopped || !this.control) {
      throw new Error("Realtime has stopped.");
    }

    this.control.send(event);
  }

  /**
  Revoke controls immediately and release the provider's media session once.
  @returns Completion of provider hangup.
  */
  close() {
    this.stopped = true;
    this.control?.close();
    this.closing ??= this.hangup();

    return this.closing;
  }
}
