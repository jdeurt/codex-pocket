/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- History operations are bound to the constructor's thread identity. */
import { type VoiceSegment } from "../lib/voice-history";
import { createSavedVoiceStore } from "../state/saved-voice";
import { voiceStorage } from "./voice-storage";
import { type Data, string } from "../lib/protocol";
import { createHash } from "node:crypto";

/**
Persist finalized captions and retain legacy handoff status; never store raw microphone audio.
*/
export class VoiceHistory {
  private persisted: ReturnType<typeof createSavedVoiceStore>;
  private hydration?: Promise<void>;

  /** Bind a vanilla persisted store to one conversation and this host's storage adapter.
  @param threadId - Native conversation identity.
  */
  constructor(threadId: string) {
    const key = createHash("sha256").update(threadId).digest("hex");

    this.persisted = createSavedVoiceStore(key, voiceStorage());
  }

  /** Restore saved speech once without replaying work or sharing state across conversations.
  @returns Current validated ledger after explicit hydration.
  */
  async read() {
    this.hydration ??= this.persisted.hydrate();
    await this.hydration;

    return this.persisted.store.getState().segments;
  }

  /**
  Persist an immutable final caption independently of live audio and the UI.
  */
  async finalize(event: Data, sessionId: string, role: "user" | "assistant", afterItemId: string | null) {
    const itemId = string(event.item_id);

    if (!itemId) {
      return;
    }

    const id = `realtime:${sessionId}:${itemId}:${role}`;
    const entries = await this.read();
    const existing = entries.find((entry) => entry.id === id);
    const entry: VoiceSegment = {
      ...existing,
      id,
      itemId,
      nativeSessionId: sessionId,
      role,
      text: string(event.transcript),
      done: true,
      afterItemId: existing ? existing.afterItemId : afterItemId,
    };

    await this.save(entry);

    return entry;
  }

  /**
  Persist the complete finalized transcript on the independent history queue.
  */
  async save(entry: VoiceSegment) {
    const entries = await this.read();
    const existing = entries.find((candidate) => candidate.id === entry.id);

    if (existing && existing.text !== entry.text) {
      throw new Error("Finalized caption changed for an existing item.");
    }

    const segments = existing
      ? entries.map((candidate) => (candidate.id === entry.id ? entry : candidate))
      : [...entries, entry];

    this.persisted.store.setState({ segments });
  }
}
