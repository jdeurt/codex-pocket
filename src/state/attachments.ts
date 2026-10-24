import { createStore } from "zustand/vanilla";
import { type SavedDraft } from "../lib/draft-attachments";

/** Create observable attachment and persistence state independently of upload requests.
@returns Fresh per-conversation store; files hydrate from IndexedDB after mount.
*/
export function createAttachmentStore() {
  return createStore<{ draft: SavedDraft; ready: boolean; error: string; isPersisted: boolean }>(() => ({
    draft: { files: [] },
    ready: false,
    error: "",
    isPersisted: true,
  }));
}
