/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- History operations are bound to the constructor's thread identity. */
import { type VoiceSegment, voiceHistorySchema } from "../lib/voice-history";
import { readLocal, writeLocal } from "./local-state";
import { createHash } from "node:crypto";

/**
Persist only finalized speech and explicit handoff status; never store raw microphone audio.
*/
export class VoiceHistory {
  private entries?: VoiceSegment[];
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
  async read() {
    if (!this.entries) {
      this.entries = voiceHistorySchema.parse(await readLocal(this.filename, []));

      for (const entry of this.entries) {
        if (entry.handoff === "sending") {
          entry.handoff = "unknown";
        }
      }
    }

    return this.entries;
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
