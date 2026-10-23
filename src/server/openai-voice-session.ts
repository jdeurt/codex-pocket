/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- Session operations share one owner and explicit provider identity. */
import { type Data, object, string } from "../lib/protocol";
import { OpenAIRealtime } from "./openai-realtime";
import { type VoiceSessionOwner, readVoiceConfiguration } from "./voice-session-owner";

import { VoiceTurns } from "./voice-turns";
import { VoiceHistory } from "./voice-history";
import { parseOutputAudio } from "./realtime-schema";
import { VoiceSessionStop, handoffVoice, publishVoiceHandoff, retryVoice, settleVoice } from "./voice-handoff";

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
  private serial: Promise<void> = Promise.resolve();
  private turns = new VoiceTurns();
  private stopping = new VoiceSessionStop();

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
    this.history ??= new VoiceHistory(this.owner.threadId());

    return this.history;
  }

  /**
  Start one response only after transcription has finalized, preserving its stable source identity.
  */
  private respond() {
    this.turns.respond(this.phase === "active" ? this.transport : undefined);
  }

  /**
  Save final speech verbatim before displaying it or allowing a tool handoff.
  */
  private async finalized(event: Data, sessionId: string, role: "user" | "assistant") {
    const itemId = string(event.item_id);
    const afterItemId = this.turns.anchor(itemId, sessionId, role, this.owner.lastItemId?.() ?? null);
    const entry = await this.savedHistory().finalize(event, sessionId, role, afterItemId);

    if (!entry) {
      return;
    }

    this.publish({ type: "transcriptDone", ...entry });

    if (role !== "user") {
      return;
    }

    this.turns.observe(event);
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
    const entry = await handoffVoice(
      this.owner,
      this.savedHistory(),
      event,
      sessionId,
      this.turns.current?.items ?? []
    );

    if (this.transport !== transport) {
      return;
    }

    publishVoiceHandoff(
      event,
      entry,
      this.turns.current?.items ?? [],
      (message) => {
        this.publish(message);
      },
      (message) => transport?.send(message)
    );
  }

  /**
  Translate only the provider events used by Pocket; raw frames stay off browser streams.
  */
  private async receive(event: Data, sessionId: string) {
    if (
      ["response.created", "response.output_audio.delta", "response.output_audio_transcript.done"].includes(
        string(event.type)
      ) &&
      !this.turns.output(event)
    ) {
      return;
    }

    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        this.turns.anchor(string(event.item_id), sessionId, "user", this.owner.lastItemId?.() ?? null);
        this.turns.observe(event);
        this.publish({ type: "interrupted" });
        break;
      }

      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed": {
        this.turns.anchor(string(event.item_id), sessionId, "user", this.owner.lastItemId?.() ?? null);
        this.turns.observe(event);
        this.respond();
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

      case "response.done": {
        if (await this.turns.complete(event, (call) => this.handoff(call, sessionId))) {
          this.respond();
        }

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
  Connect only while this start attempt still owns the session.
  */
  private async connect(attempt: number, endpoint?: string) {
    const settings = await readVoiceConfiguration(this.owner);

    if (this.attempt !== attempt) {
      throw new Error("Realtime stopped while connecting.");
    }

    const sessionId = crypto.randomUUID();
    const transport = new OpenAIRealtime((event) => {
      if (this.transport !== transport) {
        return;
      }

      this.serial = this.enqueue(this.serial, event, sessionId, transport);
    });

    this.token = crypto.randomUUID();
    this.transport = transport;
    this.error = undefined;
    this.turns = new VoiceTurns();

    await transport.connect(settings.key, settings.voice, settings.model, endpoint);

    if (this.transport !== transport) {
      throw new Error("Realtime stopped while connecting.");
    }

    this.phase = "active";
    this.publish({ type: "started" });

    return { token: this.token, nativeSessionId: sessionId, phase: this.phase };
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
  Synchronize played audio only for the current browser owner.
  */
  truncate(token: string, itemId: string, audioEndMs: number) {
    if (this.owns(token) && this.phase === "active") {
      this.transport?.truncate(itemId, audioEndMs);
    }
  }

  /**
  Reject new audio, finalize captured speech, then revoke the stream token.
  */
  stop(token: string) {
    if (!this.owns(token)) {
      return Promise.resolve();
    }

    const transport = this.transport;

    this.phase = "stopping";

    return this.stopping.run(
      token,
      async () => {
        await transport?.finishInput();
        await this.serial;
      },
      () => {
        if (this.transport !== transport) {
          return;
        }

        this.token = undefined;
        transport?.close();
        this.transport = undefined;
        this.phase = "idle";
        this.publish({ type: "closed" });
      }
    );
  }

  /**
  Send saved speech only on an explicit request, with the original durable receipt.
  */
  retry(id: string) {
    const task = retryVoice(this.serial, this.owner, this.savedHistory(), id, () => this.phase === "idle");

    this.serial = settleVoice(task);

    return task;
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
