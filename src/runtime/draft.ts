import { createStore } from "zustand/vanilla";
import { type PersistStorage, persist } from "zustand/middleware";
import { draftData, draftState, editedDraft, restoredDraft, type DraftData, type DraftState } from "../state/draft";

/**
Own the explicit revision fence required by Zustand's asynchronous hydration callbacks.
*/
class DraftHydration {
  revision = 0;

  /** Record the revision before a storage read.
  @param state - Current draft when hydration begins.
  */
  begin = (state: DraftState) => {
    this.revision = state.revision;
  };

  /** Apply the pure hydration decision to the newest live revision.
  @param saved - Persisted data.
  @param current - Live state after the read.
  @returns Safely restored draft data.
  */
  merge = (saved: unknown, current: DraftState) => restoredDraft(saved, current, this.revision);
}

/** Allocate persisted draft state without touching storage during SSR.
@param name - Pocket-scoped storage key.
@param storage - Explicit runtime persistence adapter.
@returns Observable store with manual hydration and revision-safe merging.
*/
export function createDraftStore(name: string, storage: PersistStorage<DraftData>) {
  const hydration = new DraftHydration();

  return createStore<DraftState>()(
    persist<DraftState, [], [], DraftData>(draftState, {
      name,
      storage,
      version: 1,
      skipHydration: true,
      partialize: draftData,
      onRehydrateStorage: hydration.begin,
      merge: hydration.merge,
    })
  );
}

/** Publish a user edit, allowing Zustand middleware to persist the durable subset.
@param store - Draft runtime owner.
@param text - User-entered text.
*/
export function editDraft(store: ReturnType<typeof createDraftStore>, text: string) {
  store.setState(editedDraft(store.getState(), text));
}
