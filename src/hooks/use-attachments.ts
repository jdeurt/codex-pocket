"use client";
import { useEffect } from "react";
import { useStore } from "zustand";
import { usePocketClient } from "../providers/pocket-state";

export type { DraftAttachment } from "../lib/draft-attachments";

/** Subscribe to the conversation's upload and persisted draft owner.
@param parent - Connected native conversation identity.
@returns Renderable attachment state and stable upload actions.
*/
export function useAttachments(parent?: string) {
  const { attachments } = usePocketClient();
  const state = useStore(attachments.store);

  useEffect(() => (parent ? attachments.connect(parent) : undefined), [attachments, parent]);

  return { ...attachments, ...state.draft, ready: state.ready && !!parent, error: state.error };
}
