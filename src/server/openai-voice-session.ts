import { t as captureResult } from "try";
import { type Data, object, string } from "../lib/protocol";
import { OpenAIRealtime } from "./openai-realtime";
import { type VoiceSessionOwner, readVoiceConfiguration } from "./voice-session-owner";
import { RealtimeTools } from "./realtime-tools";
import { RealtimeCaptions } from "./realtime-captions";
import { log } from "./logging";

/**
Own call controls and history while WebRTC carries audio directly between the browser and OpenAI.
*/
export class OpenAIVoiceSession extends EventTarget {
  private token?: string;
  private attempt = 0;
  private phase: "idle" | "connecting" | "active" = "idle";
  private error?: string;
  private transport?: OpenAIRealtime;
  private tools?: RealtimeTools;
  private readonly captions;

  /**
  Bind the main agent used as a tool by the realtime conversational agent.
  @param owner - Canonical conversation and delegated worker interface.
  */
  constructor(private owner: VoiceSessionOwner) {
    super();
    this.captions = new RealtimeCaptions(owner, this.publish.bind(this));
  }

  /**
  Publish status and transcript events; media never passes through this feed.
  @param event - Browser control or transcript event.
  */
  private publish(event: Data) {
    this.dispatchEvent(new CustomEvent("message", { detail: event }));
  }

  /**
  Handle control events immediately; audio is played by the browser's WebRTC receiver.
  @param event - Provider control frame.
  @param sessionId - Original native call identity.
  */
  private receive(event: Data, sessionId: string) {
    this.tools?.receive(event);

    this.captions.receive(event, sessionId);

    switch (event.type) {
      case "error": {
        void this.disconnect(string(object(event.error).message) || "OpenAI Realtime failed.");
        break;
      }

      case "closed": {
        void this.disconnect("OpenAI Realtime disconnected. Start voice again to continue.");
        break;
      }
    }
  }

  /** Reject stale control events from a previous native connection.
  @param attempt - Native connection generation.
  @param sessionId - Original native call identity.
  @param event - Provider control event.
  */
  private received(attempt: number, sessionId: string, event: Data) {
    if (this.attempt === attempt && this.transport) {
      this.receive(event, sessionId);
    }
  }

  /** Surface the original tool-control failure and revoke only its owning call.
  @param attempt - Native connection generation.
  @param error - Original transport failure.
  */
  private toolFailed(attempt: number, error: unknown) {
    log().error({ error }, "realtime.tool_delivery_failed");

    if (this.attempt === attempt) {
      void this.disconnect("Realtime tool results could not be delivered. Start voice again to continue.");
    }
  }

  /** End the voice connection only while the requesting tool still owns it.
  @param attempt - Original native connection generation.
  */
  private async endCall(attempt: number) {
    if (this.attempt === attempt && this.token) {
      await this.stop(this.token);
    }
  }

  /**
  Negotiate one call and attach its tool connection before returning the browser's SDP.
  @param attempt - Reserved native connection generation.
  @param sdp - Browser media offer.
  @param endpoint - Optional provider endpoint override.
  @returns Browser answer and owned call identity.
  */
  private async connect(attempt: number, sdp: string, endpoint?: string) {
    const settings = await readVoiceConfiguration(this.owner);

    if (this.attempt !== attempt) {
      throw new Error("Realtime stopped while connecting.");
    }

    const context = this.owner.context?.(await this.captions.context()) ?? "";

    if (this.attempt !== attempt) {
      throw new Error("Realtime stopped while loading context.");
    }

    const sessionId = crypto.randomUUID();
    const transport = new OpenAIRealtime(this.received.bind(this, attempt, sessionId));

    this.token = crypto.randomUUID();
    this.transport = transport;
    this.error = undefined;
    this.captions.reset();
    this.tools = new RealtimeTools(
      sessionId,
      this.owner,
      transport.send.bind(transport),
      this.toolFailed.bind(this, attempt),
      this.endCall.bind(this, attempt)
    );
    const answer = await transport.connect(settings.key, settings.voice, sdp, settings.model, endpoint, context);

    if (this.transport !== transport) {
      throw new Error("Realtime stopped while connecting.");
    }

    this.phase = "active";

    return { token: this.token, nativeSessionId: sessionId, sdp: answer, phase: this.phase };
  }

  /**
  Read saved speech independently of the live call.
  @returns Finalized captions after observed durable writes.
  */
  async transcripts() {
    return this.captions.read();
  }

  /**
  Return a worker result to the realtime agent's original tool call.
  @param id - Original worker delivery receipt.
  @param text - Actual worker answer.
  @param status - Native turn completion status.
  */
  answer(id: string, text: string, status = "completed") {
    this.tools?.answer(id, text, status);
  }

  /**
  Reserve one browser owner before asynchronous session negotiation.
  @param sdp - Browser media offer.
  @param endpoint - Optional provider endpoint override.
  @returns Native media answer and owned call identity.
  */
  async start(sdp: string, endpoint?: string) {
    if (this.phase !== "idle") {
      throw new Error("Realtime is already active for this Pocket.");
    }

    this.phase = "connecting";
    const attempt = ++this.attempt;

    const completed = await captureResult(this.connect(attempt, sdp, endpoint));

    if (completed.ok) {
      return completed.value;
    }

    const error = completed.error;

    if (this.attempt === attempt) {
      void this.disconnect(error instanceof Error ? error.message : "OpenAI Realtime could not start.");
    }

    throw error;
  }

  /**
  Stop media and controls without waiting for transcript completion.
  @param token - Browser ownership credential.
  */
  async stop(token: string) {
    if (!this.owns(token)) {
      return;
    }

    const transport = this.transport;

    this.token = undefined;
    this.transport = undefined;
    this.tools?.close();
    this.tools = undefined;
    this.phase = "idle";
    this.publish({ type: "closed" });
    await transport?.close();
  }

  /**
  Check the current browser owner for control requests.
  @param token - Presented ownership credential.
  @returns Whether this browser owns the current call.
  */
  owns(token: string) {
    return !!this.token && token === this.token;
  }

  /**
  Expose control state without credentials or raw provider frames.
  @returns Public call phase and error.
  */
  status() {
    return { type: this.phase, error: this.error };
  }

  /**
  Replay current caption state when the observer attaches after media has already connected.
  @returns Bounded live caption frames.
  */
  liveCaptions() {
    return this.captions.live();
  }

  /**
  Revoke stale control and tool callbacks immediately and release the provider call.
  @param message - Public reason for call termination.
  */
  async disconnect(message: string) {
    this.attempt++;
    const transport = this.transport;

    this.token = undefined;
    this.transport = undefined;
    this.tools?.close();
    this.tools = undefined;
    this.phase = "idle";
    this.error = message;
    this.publish({ type: "error", error: message });

    const closed = transport ? await captureResult(transport.close.bind(transport)) : undefined;

    if (!closed || closed.ok) {
      return;
    }

    log().error({ error: closed.error }, "realtime.close_failed");
    this.publish({ type: "warning", error: "Realtime call closure could not be confirmed." });
  }
}
