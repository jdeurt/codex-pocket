import { type PersistStorage, type StorageValue } from "zustand/middleware";
import { type DraftData } from "../state/draft";

/** Read a legacy plain-text key at the browser storage boundary.
@param name - Pocket-scoped storage key.
@returns Versioned draft data or no saved draft.
*/
function readDraft(name: string) {
  const text = localStorage.getItem(name);

  return text === null ? null : { state: { text }, version: 1 };
}

/** Persist plain text without changing installed users' storage format.
@param name - Pocket-scoped storage key.
@param value - Validated Zustand persistence envelope.
*/
function writeDraft(name: string, value: StorageValue<DraftData>) {
  localStorage.setItem(name, value.state.text);
}

/** Remove a draft at the browser storage boundary.
@param name - Pocket-scoped storage key.
*/
function removeDraft(name: string) {
  localStorage.removeItem(name);
}

/** Create an adapter without reading browser globals during SSR.
@returns Explicit browser persistence operations.
*/
export function browserDraftStorage(): PersistStorage<DraftData> {
  return { getItem: readDraft, setItem: writeDraft, removeItem: removeDraft };
}
