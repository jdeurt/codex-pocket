/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- Session operations share one owner and explicit provider identity. */
import { type Data, object, string } from "../lib/protocol";
import { OpenAIRealtime, REALTIME_VOICES, responseForSpeech } from "./openai-realtime";
import { type VoiceSegment } from "../lib/voice-history";
import { type VoiceSessionOwner } from "./voice-session-owner";

import { VoiceHistory } from "./voice-history";
import { parseOutputAudio } from "./realtime-schema";
import { handoffVoice } from "./voice-handoff";

/**
Connect OpenAI speech to durable, verbatim main-session handoffs without depending on a harness transport.
*/
export class OpenAIVoiceSession extends EventTarget {
  private token?: string;
  private attempt = 0;
  private phase: "idle" | "connecting" | "active" | "stopping" = "idle";
  private error?: string;
  private transport?: OpenAIRealtime;
  private history?: VoiceHistory;
  private historyThread?: string;
  private serial: Promise<void> = Promise.resolve();
  private latestItemId?: string;
  private responding = false;
  private waiting: string[] = [];

  /**
  Bind credentials and durable main-session delivery.
  */
  constructor(private owner: VoiceSessionOwner) {
    super();
  }

  /**
  Publish a browser-safe event.
  */
  private publish(event: Data) {
    this.dispatchEvent(new CustomEvent("message", { detail: event }));
  }

  /**
  Handle events in provider order and reject stale session work after any asynchronous wait.
  */
  private async enqueue(previous: Promise<void>, event: Data, sessionId: string, transport: OpenAIRealtime) {
    await previous;

    if (this.transport !== transport) {
      return;
    }

    try {
      await this.receive(event, sessionId);
    } catch (error) {
      this.disconnect(error instanceof Error ? error.message : "Realtime processing failed.");
    }
  }

  /**
  Restore the selected conversation's finalized speech.
  */
  private savedHistory() {
    const threadId = this.owner.threadId();

    if (!this.history || this.historyThread !== threadId) {
      this.history = new VoiceHistory(threadId);
      this.historyThread = threadId;
    }

    return this.history;
  }

  /**
  Start one response only after transcription has finalized, preserving its stable source identity.
  */
  private respond() {
    if (this.responding || this.phase !== "active") {
      return;
    }

    const itemId = this.waiting.shift();

    if (!itemId) {
      return;
    }

    this.responding = true;
    this.transport?.send(responseForSpeech(itemId));
  }

  /**
  Save final speech verbatim before displaying it or allowing a tool handoff.
  */
  private async finalized(event: Data, sessionId: string, role: "user" | "assistant") {
    const itemId = string(event.item_id);
    const text = string(event.transcript);

    if (!itemId || !text.trim()) {
      return;
    }

    const id = `realtime:${sessionId}:${itemId}:${role}`;
    const history = this.savedHistory();
    const entries = await history.read();
    const existing = entries.find((entry) => entry.id === id);
    const entry: VoiceSegment = { id, itemId, nativeSessionId: sessionId, role, text, done: true };

    await history.save({ ...entry, ...(existing?.handoff && { handoff: existing.handoff }) });
    this.publish({ type: "transcriptDone", role, text, itemId, id, nativeSessionId: sessionId });

    if (role !== "user" || existing) {
      return;
    }

    this.latestItemId = itemId;
    this.waiting.push(itemId);
    this.respond();
  }

  /**
  Resolve tool arguments exclusively against finalized speech and record delivery before dispatch.
  */
  private async handoff(event: Data, sessionId: string) {
    if (event.name !== "handoff_to_pocket" || this.phase !== "active") {
      return;
    }

    const transport = this.transport;
    const entry = await handoffVoice(this.owner, this.savedHistory(), event, sessionId, this.latestItemId);

    if (this.transport !== transport) {
      return;
    }

    this.publish({ type: "handoff", itemId: entry.itemId, status: entry.handoff });

    if (this.status().type === "active") {
      this.transport?.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: event.call_id,
          output: JSON.stringify({ status: entry.handoff }),
        },
      });
    }
  }

  /**
  Translate only the provider events used by Pocket; raw frames stay off browser streams.
  */
  private async receive(event: Data, sessionId: string) {
    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        this.publish({ type: "interrupted" });
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        await this.finalized(event, sessionId, "user");
        break;
      }

      case "response.output_audio_transcript.done": {
        await this.finalized(event, sessionId, "assistant");
        break;
      }

      case "response.output_audio.delta": {
        const audio = parseOutputAudio({ data: event.delta, sampleRate: 24_000, numChannels: 1 });

        if (audio && this.phase === "active") {
          this.publish({ type: "audio", audio, itemId: event.item_id });
        }

        break;
      }

      case "response.function_call_arguments.done": {
        await this.handoff(event, sessionId);
        break;
      }

      case "response.done": {
        this.responding = false;
        this.respond();
        break;
      }

      case "error": {
        this.disconnect(string(object(event.error).message) || "OpenAI Realtime failed.");
        break;
      }

      case "closed": {
        this.disconnect("OpenAI Realtime disconnected. Start voice again to continue.");
        break;
      }
      // No default
    }
  }

  /**
  Finish provider transcription and then the corresponding persistence queue.
  */
  private async finishInput() {
    await this.transport?.finishInput();
    await this.serial;
  }

  /**
  Connect only while this start attempt still owns the session.
  */
  private async connect(attempt: number, endpoint?: string) {
    const key = await this.owner.readKey();

    if (!key) {
      throw new Error("Add an OpenAI API key in Settings to enable realtime voice.");
    }

    const settings = await this.owner.preferences();

    if (!REALTIME_VOICES.includes(settings.voice)) {
      throw new Error("Choose a supported OpenAI realtime voice in Settings.");
    }

    if (this.attempt !== attempt) {
      throw new Error("Realtime stopped while connecting.");
    }

    const token = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const transport = new OpenAIRealtime((event) => {
      if (this.transport !== transport) {
        return;
      }

      this.serial = this.enqueue(this.serial, event, sessionId, transport);
    });

    this.token = token;
    this.transport = transport;
    this.phase = "connecting";
    this.error = undefined;
    this.responding = false;
    this.waiting = [];
    this.latestItemId = undefined;

    await transport.connect(key, settings.voice, settings.model, endpoint);

    if (this.transport !== transport) {
      throw new Error("Realtime stopped while connecting.");
    }

    this.phase = "active";
    this.publish({ type: "started" });

    return { token, nativeSessionId: sessionId, phase: this.phase };
  }

  /**
  Return the exact finalized transcript and the explicit handoff receipt status after reload.
  */
  async transcripts() {
    return this.savedHistory().read();
  }

  /**
  Reserve this session before asynchronous credential reads can admit a second start.
  */
  async start(endpoint?: string) {
    if (this.phase !== "idle") {
      throw new Error("Realtime is already active or stopping for this Pocket.");
    }

    this.phase = "connecting";
    const attempt = ++this.attempt;

    try {
      return await this.connect(attempt, endpoint);
    } catch (error) {
      if (this.attempt === attempt) {
        this.disconnect(error instanceof Error ? error.message : "OpenAI Realtime could not start.");
      }

      throw error;
    }
  }

  /**
  Forward validated audio only for the current browser token.
  */
  append(token: string, input: unknown) {
    if (!this.owns(token) || this.phase !== "active") {
      throw new Error("Realtime has stopped.");
    }

    this.transport?.append(input);
  }

  /**
  Reject new audio, finalize captured speech, then revoke the stream token.
  */
  async stop(token: string) {
    if (!this.owns(token)) {
      return;
    }

    this.phase = "stopping";

    try {
      await this.finishInput();
    } finally {
      this.token = undefined;
      this.transport?.close();
      this.transport = undefined;
      this.phase = "idle";
      this.publish({ type: "closed" });
    }
  }

  /**
  Check the private stream owner on each request.
  */
  owns(token: string) {
    return !!this.token && token === this.token;
  }

  /**
  Expose lifecycle state without credentials.
  */
  status() {
    return { type: this.phase, error: this.error };
  }

  /**
  Fail closed without replaying tool actions or accepting audio for a stale token.
  */
  disconnect(message: string) {
    this.attempt++;
    this.token = undefined;
    this.transport?.close();
    this.transport = undefined;
    this.phase = "idle";
    this.error = message;
    this.publish({ type: "error", error: message });
  }
}
