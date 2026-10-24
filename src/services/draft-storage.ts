import { type PersistStorage } from "zustand/middleware";
import { type DraftData } from "../state/draft";

/** Adapt existing plain-text draft keys to Zustand persistence without losing installed users' drafts.
@returns Lazy browser adapter; construction never touches browser storage during SSR.
*/
export function browserDraftStorage(): PersistStorage<DraftData> {
  return {
    getItem: (name) => {
      const text = localStorage.getItem(name);

      return text === null ? null : { state: { text }, version: 1 };
    },
    setItem: (name, value) => {
      localStorage.setItem(name, value.state.text);
    },
    removeItem: (name) => {
      localStorage.removeItem(name);
    },
  };
}
