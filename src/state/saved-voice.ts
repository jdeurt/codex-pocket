import { voiceHistorySchema, type VoiceSegment } from "../lib/voice-history";
import { z } from "zod";

export const savedVoiceSchema = z.object({ segments: voiceHistorySchema });

export type SavedVoice = z.infer<typeof savedVoiceSchema>;

/** Create an empty durable caption ledger.
@returns Caption data before runtime hydration.
*/
export function savedVoiceState(): SavedVoice {
  return { segments: [] };
}

/** Select only durable captions for persistence.
@param state - Current caption ledger.
@returns Persisted data, excluding runtime callbacks or resources.
*/
export function savedVoiceData(state: SavedVoice): SavedVoice {
  return { segments: state.segments };
}

/** Reject unsupported persistence versions without losing existing data.
@returns Never returns; callers must surface the incompatible version.
*/
export function rejectVoiceMigration(): never {
  throw new Error("Saved voice history uses an unsupported version.");
}

/** Add or replace finalized metadata without rewriting an existing caption's text.
@param entries - Current immutable ledger.
@param entry - Finalized caption.
@returns Updated ledger, or a validation error for conflicting text.
*/
export function finalizedCaptions(entries: VoiceSegment[], entry: VoiceSegment): VoiceSegment[] {
  const segments: VoiceSegment[] = [];

  let isFound = false;

  for (const candidate of entries) {
    if (candidate.id !== entry.id) {
      segments.push(candidate);
      continue;
    }

    if (candidate.text !== entry.text) {
      throw new Error("Finalized caption changed for an existing item.");
    }

    segments.push(entry);
    isFound = true;
  }

  return isFound ? segments : [...segments, entry];
}

/** Restore a legacy send receipt without treating an interrupted send as confirmed.
@param entry - Persisted legacy caption.
@returns Caption with explicit uncertainty for an unfinished handoff.
*/
export function restoredVoiceSegment(entry: VoiceSegment): VoiceSegment {
  return entry.handoff === "sending" ? { ...entry, handoff: "unknown" } : entry;
}
