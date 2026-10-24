import { createDraftStore } from "../state/draft";
import { createResourceStore } from "../state/resource";
import { browserDraftStorage } from "./draft-storage";
import { t as attempt } from "try";

/** Own manual browser hydration, cross-tab synchronization and durable draft writes.
@param pocketId - Explicit per-tab identity, fixed for this controller's lifetime.
@returns Draft state and actions without reading browser globals during server rendering.
*/
export function createDraftController(pocketId: string) {
  const key = pocketId === "main" ? "codex-pocket-draft" : `codex-pocket-draft:${pocketId}`;
  const store = createDraftStore(key, browserDraftStorage());
  const hydration = createResourceStore<boolean>();
  const isStored = () => (localStorage.getItem(key) ?? "") === store.getState().text;
  const isSaved = () => {
    const outcome = attempt(isStored);

    return outcome.ok ? outcome.value : store.getState().text === "";
  };
  const setText = (text: string) => {
    const saved = attempt(() => {
      store.getState().edit(text);
      hydration.setState({ error: undefined });
    });

    if (!saved.ok) {
      hydration.setState({ error: "Draft could not be saved on this device." });
    }
  };
  const hydrate = async () => {
    await store.persist.rehydrate();
    hydration.setState({
      data: store.persist.hasHydrated(),
      isLoading: false,
      error: store.persist.hasHydrated() ? undefined : "Saved draft could not be restored on this device.",
    });
  };

  return {
    store,
    hydration,
    setText,
    isSaved,
    connect: () => {
      void hydrate();
      const changed = (event: StorageEvent) => {
        if (event.key === key || event.key === null) {
          void hydrate();
        }
      };

      globalThis.addEventListener("storage", changed);

      return () => {
        globalThis.removeEventListener("storage", changed);
      };
    },
  };
}
