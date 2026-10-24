import { type VoiceSegment } from "../lib/voice-history";

export type VoicePhase = "idle" | "starting" | "active" | "stopping";
export interface VoiceState {
  state: VoicePhase;
  error: string;
  historyError: string;
  segments: VoiceSegment[];
}

/** Create caption and lifecycle data without retaining media resources.
@param segments - Finalized captions from server hydration.
@returns Initial idle voice projection.
*/
export function voiceState(segments: VoiceSegment[] = []): VoiceState {
  return { state: "idle", error: "", historyError: "", segments };
}

/** Merge captions by identity, retaining final text over late partial events.
@param segments - Existing captions, left unchanged.
@param entries - Incoming live or saved captions, left unchanged.
@returns Merged captions in stable insertion order.
*/
export function reconcileCaptions(segments: VoiceSegment[], entries: VoiceSegment[]): VoiceSegment[] {
  const merged = new Map<string, VoiceSegment>();

  for (const entry of segments) {
    merged.set(entry.id, entry);
  }

  for (const entry of entries) {
    if (!merged.get(entry.id)?.done || entry.done) {
      merged.set(entry.id, entry);
    }
  }

  return merged.values().toArray();
}
