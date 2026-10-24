import { t as captureResult } from "try";
/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- Operations share one voice connection owner. */
import { type Data, object, string } from "../lib/protocol";
import { OpenAIRealtime } from "./openai-realtime";
import { type VoiceSessionOwner, readVoiceConfiguration } from "./voice-session-owner";
import { RealtimeTools } from "./realtime-tools";
import { VoiceHistory } from "./voice-history";

const LIVE_CAPTION_LIMIT = 256;

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
  private history?: VoiceHistory;
  private persistence: Promise<void> = Promise.resolve();
  private anchors = new Map<string, string | null>();
  private lastCanonical?: string | null;
  private lastVoice?: string;
  private partial = new Map<string, string>();
  private captions = new Map<string, Data>();

  /**
  Bind the main agent used as a tool by the realtime conversational agent.
  */
  constructor(private owner: VoiceSessionOwner) {
    super();
  }

  /**
  Publish status and transcript events; media never passes through this feed.
  */
  private publish(event: Data) {
    if (event.type === "transcriptDelta" || event.type === "transcriptDone") {
      this.captions.set(string(event.id), event);

      if (this.captions.size > LIVE_CAPTION_LIMIT) {
        this.captions.delete(this.captions.keys().next().value ?? "");
      }
    }

    this.dispatchEvent(new CustomEvent("message", { detail: event }));
  }

  /**
  Restore finalized speech for the selected Pocket.
  */
  private savedHistory() {
    this.history ??= new VoiceHistory(this.owner.threadId());

    return this.history;
  }

  /**
  Anchor provider speech immediately, regardless of when transcription completes.
  */
  private anchor(itemId: string, sessionId: string, role: "user" | "assistant") {
    const id = `realtime:${sessionId}:${itemId}:${role}`;

    if (!this.anchors.has(id)) {
      const canonical = this.owner.lastItemId?.() ?? null;
      const previous = this.lastCanonical === canonical ? (this.lastVoice ?? canonical) : canonical;

      this.anchors.set(id, previous);
      this.lastCanonical = canonical;
      this.lastVoice = id;
    }

    return this.anchors.get(id) ?? null;
  }

  /**
  Save transcripts on their own queue; a slow or failed write cannot gate audio or tool calls.
  */
  private finalized(event: Data, sessionId: string, role: "user" | "assistant") {
    const afterItemId = this.anchor(string(event.item_id), sessionId, role);

    this.partial.delete(string(event.item_id));
    this.reply(event, sessionId, role, string(event.transcript), true);
    const history = this.savedHistory();

    this.persistence = this.persist(this.persistence, history, event, sessionId, role, afterItemId);
  }

  /**
  Serialize only history writes and surface their failures without disconnecting media.
  */
  private async persist(
    previous: Promise<void>,
    history: VoiceHistory,
    event: Data,
    sessionId: string,
    role: "user" | "assistant",
    afterItemId: string | null
  ) {
    await previous;

    const completed = await captureResult(history.finalize(event, sessionId, role, afterItemId));

    if (!completed.ok) {
      this.publish({ type: "warning", error: "Voice history could not be saved. Your live call is still connected." });
    }
  }

  /**
  Publish reply text supplied with the audio without waiting for storage.
  */
  private reply(event: Data, sessionId: string, role: "user" | "assistant", text: string, isDone: boolean) {
    const itemId = string(event.item_id);

    this.publish({
      type: isDone ? "transcriptDone" : "transcriptDelta",
      id: `realtime:${sessionId}:${itemId}:${role}`,
      itemId,
      nativeSessionId: sessionId,
      role,
      text,
      done: isDone,
      afterItemId: this.anchor(itemId, sessionId, role),
    });
  }

  /**
  Handle control events immediately; audio is played by the browser's WebRTC receiver.
  */
  private receive(event: Data, sessionId: string) {
    this.tools?.receive(event);

    switch (event.type) {
      case "response.output_item.added": {
        const item = object(event.item);

        if (item.type === "message" && item.role === "assistant") {
          this.anchor(string(item.id), sessionId, "assistant");
        }

        break;
      }

      case "input_audio_buffer.speech_started":
      case "input_audio_buffer.committed": {
        this.anchor(string(event.item_id), sessionId, "user");
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        this.finalized(event, sessionId, "user");
        break;
      }

      case "conversation.item.input_audio_transcription.failed": {
        this.publish({ type: "warning", error: "Some captions are unavailable. Your live audio is still connected." });
        break;
      }

      case "conversation.item.input_audio_transcription.delta":
      case "response.output_audio_transcript.delta": {
        const itemId = string(event.item_id);
        const text = (this.partial.get(itemId) ?? "") + string(event.delta);

        this.partial.set(itemId, text);
        const role = event.type === "response.output_audio_transcript.delta" ? "assistant" : "user";

        this.reply(event, sessionId, role, text, false);
        break;
      }

      case "response.output_audio_transcript.done": {
        this.finalized(event, sessionId, "assistant");
        break;
      }

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

  /**
  Negotiate one call and attach its tool connection before returning the browser's SDP.
  */
  private async connect(attempt: number, sdp: string, endpoint?: string) {
    const settings = await readVoiceConfiguration(this.owner);

    if (this.attempt !== attempt) {
      throw new Error("Realtime stopped while connecting.");
    }

    const context = this.owner.context?.(await this.savedHistory().read()) ?? "";

    if (this.attempt !== attempt) {
      throw new Error("Realtime stopped while loading context.");
    }

    const sessionId = crypto.randomUUID();
    const transport = new OpenAIRealtime((event) => {
      if (this.transport === transport) {
        this.receive(event, sessionId);
      }
    });

    this.token = crypto.randomUUID();
    this.transport = transport;
    this.error = undefined;
    this.anchors.clear();
    this.partial.clear();
    this.captions.clear();
    this.lastCanonical = undefined;
    this.lastVoice = undefined;
    this.tools = new RealtimeTools(
      sessionId,
      this.owner,
      (event) => {
        transport.send(event);
      },
      () => {
        void this.disconnect("Realtime tool results could not be delivered. Start voice again to continue.");
      }
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
  */
  async transcripts() {
    await this.persistence;

    return this.savedHistory().read();
  }

  /**
  Return a worker result to the realtime agent's original tool call.
  */
  answer(id: string, text: string, status = "completed") {
    this.tools?.answer(id, text, status);
  }

  /**
  Reserve one browser owner before asynchronous session negotiation.
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
  */
  owns(token: string) {
    return !!this.token && token === this.token;
  }

  /**
  Expose control state without credentials or raw provider frames.
  */
  status() {
    return { type: this.phase, error: this.error };
  }

  /**
  Replay current caption state when the observer attaches after media has already connected.
  */
  liveCaptions() {
    return this.captions.values().toArray();
  }

  /**
  Revoke stale control and tool callbacks immediately and release the provider call.
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

    const closed = await captureResult(() => transport?.close());

    if (!closed.ok) {
      this.publish({ type: "warning", error: "Realtime call closure could not be confirmed." });
    }
  }
}
