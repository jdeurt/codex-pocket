import { createStore } from "zustand/vanilla";
import { persist, type PersistStorage } from "zustand/middleware";
import { rejectVoiceMigration, savedVoiceData, savedVoiceState, type SavedVoice } from "../state/saved-voice";

/**
Own persistence errors explicitly because Zustand reports hydration failures through callbacks.
*/
export class SavedVoiceRuntime {
  private hydrationError: unknown;

  /** Reset the outcome before each read.
  @returns Completion callback owned by this runtime instance.
  */
  private begin = () => {
    this.hydrationError = undefined;

    return this.rehydrated;
  };

  /** Capture a persistence failure without sharing it across conversations.
  @param _state - Restored data when successful.
  @param error - Storage or migration failure, if present.
  */
  private rehydrated = (_state: SavedVoice | undefined, error: unknown) => {
    this.hydrationError = error;
  };

  readonly store;

  /** Restore durable captions and propagate storage errors to the owning service.
  @returns Completion once hydration succeeds.
  */
  hydrate = async () => {
    await this.store.persist.rehydrate();

    if (!this.store.persist.hasHydrated()) {
      throw new Error("Saved voice history could not be restored.", { cause: this.hydrationError });
    }
  };

  /** Allocate a durable store without reading storage.
  @param name - Thread-scoped persistence identity.
  @param storage - Runtime persistence adapter.
  */
  constructor(name: string, storage: PersistStorage<SavedVoice>) {
    this.store = createStore<SavedVoice>()(
      persist<SavedVoice>(savedVoiceState, {
        name,
        storage,
        version: 1,
        skipHydration: true,
        migrate: rejectVoiceMigration,
        partialize: savedVoiceData,
        onRehydrateStorage: this.begin,
      })
    );
  }
}
