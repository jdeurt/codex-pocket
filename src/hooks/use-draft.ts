"use client";
import { draftText } from "../state/draft";
import { useStore } from "zustand";
import { usePocketClient } from "../providers/pocket-state";

/** Subscribe to Pocket-scoped persisted draft text.
@returns Current text and the service action responsible for saving it.
*/
export function useDraft() {
  const { draft } = usePocketClient();
  const text = useStore(draft.store, draftText);

  return [text, draft.setText] as const;
}
