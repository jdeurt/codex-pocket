import { type OpenAIRealtime } from "./openai-realtime";
import { responseForSpeech } from "./realtime-configuration";
import { completedHandoffs } from "./voice-handoff";
import { type Data, object, string } from "../lib/protocol";

export interface SpeechResponse {
  key: string;
  items: string[];
  interrupted: boolean;
  providerId?: string;
}

/**
Keep speech order and response ownership separate from transcription completion order.
*/
export class VoiceTurns {
  private items: { id: string; previous?: string; final: boolean }[] = [];
  private consumed = new Set<string>();
  private speaking?: string;
  private anchors = new Map<string, string | null>();
  private lastCanonical?: string | null;
  private lastVoice?: string;
  current?: SpeechResponse;

  /** Anchor speech to observed message identities instead of completion timestamps.
  @param itemId - Provider item identity.
  @param sessionId - Current provider session namespace.
  @param role - Explicit provider role.
  @param canonical - Last observed main-conversation item.
  @returns Durable predecessor identity for the unified transcript.
  */
  anchor(itemId: string, sessionId: string, role: "user" | "assistant", canonical: string | null) {
    if (!this.anchors.has(itemId)) {
      const preceding = this.lastCanonical === canonical ? (this.lastVoice ?? canonical) : canonical;

      this.anchors.set(itemId, preceding);
      this.lastCanonical = canonical;
      this.lastVoice = `realtime:${sessionId}:${itemId}:${role}`;
    }

    return this.anchors.get(itemId) ?? null;
  }

  /** Register provider speech identity before transcription finishes.
  @param event - Speech start, commit or final transcription event.
  */
  observe(event: Data) {
    const id = string(event.item_id);

    if (!id) {
      return;
    }

    let item = this.items.find((entry) => entry.id === id);

    if (!item) {
      item = { id, final: false };
      this.items.push(item);
    }

    if (typeof event.previous_item_id === "string") {
      item.previous = event.previous_item_id;
      const previous = this.items.findIndex((entry) => entry.id === item.previous);
      const index = this.items.indexOf(item);

      if (previous > index) {
        this.items.splice(index, 1);
        this.items.splice(previous, 0, item);
      }
    }

    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        this.speaking = id;

        if (this.current) {
          this.current.interrupted = true;
        }

        break;
      }

      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed": {
        if (this.speaking === id) {
          this.speaking = undefined;
        }

        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        item.final = true;
        break;
      }
      // No default
    }
  }

  /** Bind output to a provider response, then reject late audio after barge-in.
  @param event - Provider creation or output event.
  @returns Whether this output belongs to the uninterrupted response.
  */
  output(event: Data) {
    if (event.type === "response.created") {
      const response = object(event.response);
      const current = this.match(response);

      if (current) {
        current.providerId = string(response.id);
      }

      return false;
    }

    return !!this.current?.providerId && !this.current.interrupted && event.response_id === this.current.providerId;
  }

  /** Start a response only while the owning connection accepts work.
  @param transport - Active connection, absent during shutdown.
  */
  respond(transport?: OpenAIRealtime) {
    if (!transport) {
      return;
    }

    const response = this.next();

    if (response) {
      transport.send(responseForSpeech(response.key, response.items));
    }
  }

  /** Freeze all ready segments as one response input; never substitute a later final.
  @returns A new owned response when input is settled, otherwise undefined.
  */
  next() {
    if (this.current || this.speaking) {
      return;
    }

    const pending = this.items.filter((item) => !this.consumed.has(item.id));

    if (pending.length === 0 || pending.some((item) => !item.final)) {
      return;
    }

    this.current = { key: crypto.randomUUID(), items: pending.map((item) => item.id), interrupted: false };

    return this.current;
  }

  /** Require the provider to echo the response's application metadata.
  @param response - Provider response object.
  @returns The matching active response, excluding duplicates and stale responses.
  */
  match(response: Data) {
    return string(object(response.metadata).pocket_turn) === this.current?.key ? this.current : undefined;
  }

  /** Complete only the response that owns the echoed key, ignoring duplicates.
  @param event - Provider completion envelope.
  @param handoff - Durable tool dispatcher for this session.
  @returns Whether a completed turn permits the next response.
  */
  async complete(event: Data, handoff: (call: Data) => Promise<void>) {
    const response = object(event.response);
    const owned = this.match(response);

    if (!owned) {
      return false;
    }

    if (!owned.interrupted) {
      for (const call of completedHandoffs(event)) {
        await handoff(call);
      }
    }

    const isConsumed = response.status === "completed" && !owned.interrupted;

    const hasContinuation = this.items.some((item) => !this.consumed.has(item.id) && !owned.items.includes(item.id));

    this.finish(isConsumed);

    return isConsumed || hasContinuation;
  }

  /** Finish an owned response, retaining cancelled speech for the next utterance.
  @param isConsumed - Whether the response successfully handled its input.
  */
  finish(isConsumed: boolean) {
    if (isConsumed) {
      const items = this.current?.items ?? [];

      for (const id of items) {
        this.consumed.add(id);
      }
    }

    this.current = undefined;
  }
}
