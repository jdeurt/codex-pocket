/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- History operations are bound to the constructor's thread identity. */
import { type VoiceSegment, voiceHistorySchema } from "../lib/voice-history";
import { readLocal, writeLocal } from "./local-state";
import { type Data, string } from "../lib/protocol";
import { createHash } from "node:crypto";

/**
Persist only finalized speech and explicit handoff status; never store raw microphone audio.
*/
export class VoiceHistory {
  private entries?: Promise<VoiceSegment[]>;
  private filename: string;

  /**
  Bind the private transcript file to one main conversation.
  */
  constructor(threadId: string) {
    this.filename = `voice-history/${createHash("sha256").update(threadId).digest("hex")}.json`;
  }

  /**
  Restore saved speech without replaying any pending or uncertain tool work.
  */
  private async restore() {
    const entries = voiceHistorySchema.parse(await readLocal(this.filename, []));

    for (const entry of entries) {
      if (entry.handoff === "sending") {
        entry.handoff = "unknown";
      }
    }

    return entries;
  }

  /**
  Share hydration with concurrent history readers so they cannot replace an in-flight ledger.
  */
  read() {
    this.entries ??= this.restore();

    return this.entries;
  }

  /**
  Persist an immutable final transcript before exposing it to delivery or the UI.
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
  Persist the complete finalized transcript before acknowledging it to the browser.
  */
  async save(entry: VoiceSegment) {
    const entries = await this.read();
    const existing = entries.find((candidate) => candidate.id === entry.id);

    if (existing && existing.text !== entry.text) {
      throw new Error("Finalized speech changed for an existing item. No handoff was sent.");
    }

    if (existing) {
      Object.assign(existing, entry);
    } else {
      entries.push(entry);
    }

    await writeLocal(this.filename, entries);
  }
}
