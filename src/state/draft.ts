import { createStore } from "zustand/vanilla";
import { type PersistStorage, persist } from "zustand/middleware";
import { z } from "zod";

export const draftDataSchema = z.object({ text: z.string() });

export type DraftData = z.infer<typeof draftDataSchema>;
interface DraftState extends DraftData {
  revision: number;
  edit: (text: string) => void;
}

/** Create SSR-safe draft persistence with an injected, validated storage adapter.
@param name - Pocket-scoped storage key.
@param storage - Browser or server persistence adapter; never accessed during construction.
@returns Store with explicit hydration that cannot overwrite edits made during an async read.
*/
export function createDraftStore(name: string, storage: PersistStorage<DraftData>) {
  let hydrationRevision = 0;

  return createStore<DraftState>()(
    persist<DraftState, [], [], DraftData>(
      (set) => ({
        text: "",
        revision: 0,
        edit: (text) => set((state) => ({ text, revision: state.revision + 1 })),
      }),
      {
        name,
        storage,
        version: 1,
        skipHydration: true,
        partialize: ({ text }) => ({ text }),
        onRehydrateStorage: (state) => {
          hydrationRevision = state.revision;
        },
        merge: (saved, current) => ({
          ...current,
          text:
            saved !== undefined && current.revision === hydrationRevision
              ? draftDataSchema.parse(saved).text
              : current.text,
        }),
      }
    )
  );
}
