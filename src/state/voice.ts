import { createStore } from "zustand/vanilla";
import { type VoiceSegment } from "../lib/voice-history";

export type VoicePhase = "idle" | "starting" | "active" | "stopping";
export interface VoiceState {
  state: VoicePhase;
  error: string;
  historyError: string;
  segments: VoiceSegment[];
}

/** Create caption and lifecycle state without retaining any media resources.
@param segments - Server-hydrated finalized captions for this thread.
@returns Independent voice store whose initial lifecycle is always idle.
*/
export function createVoiceStore(segments: VoiceSegment[] = []) {
  return createStore<VoiceState>(() => ({ state: "idle", error: "", historyError: "", segments }));
}

export type VoiceStore = ReturnType<typeof createVoiceStore>;

/** Merge captions by provenance, keeping finalized text over late partial updates.
@param store - This conversation's voice store.
@param entries - Live events or saved history.
*/
export function mergeCaptions(store: VoiceStore, entries: VoiceSegment[]) {
  store.setState(({ segments }) => {
    const merged = new Map(segments.map((entry) => [entry.id, entry]));

    for (const entry of entries) {
      if (!merged.get(entry.id)?.done || entry.done) {
        merged.set(entry.id, entry);
      }
    }

    return { segments: merged.values().toArray() };
  });
}
