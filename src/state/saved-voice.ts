import { createStore } from "zustand/vanilla";
import { persist, type PersistStorage } from "zustand/middleware";
import { voiceHistorySchema } from "../lib/voice-history";
import { z } from "zod";

export const savedVoiceSchema = z.object({ segments: voiceHistorySchema });

export type SavedVoice = z.infer<typeof savedVoiceSchema>;

/** Create a persistent vanilla store with explicit async hydration and a versioned durable subset.
@param name - Thread-scoped persistence identity.
@param storage - Validated persistence implementation, including SQLite on the server.
@returns Store and hydration that propagates storage failures instead of silently overwriting history.
*/
export function createSavedVoiceStore(name: string, storage: PersistStorage<SavedVoice>) {
  let hydrationError: unknown;

  const rehydrated = (_state: SavedVoice | undefined, error: unknown) => {
    hydrationError = error;
  };
  const store = createStore<SavedVoice>()(
    persist<SavedVoice>(() => ({ segments: [] }), {
      name,
      storage,
      version: 1,
      skipHydration: true,
      migrate: () => {
        throw new Error("Saved voice history uses an unsupported version.");
      },
      partialize: ({ segments }) => ({ segments }),
      onRehydrateStorage: () => rehydrated,
    })
  );

  return {
    store,
    hydrate: async () => {
      await store.persist.rehydrate();

      if (hydrationError) {
        throw new Error("Saved voice history could not be restored.", { cause: hydrationError });
      }
    },
  };
}
