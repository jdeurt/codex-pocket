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

  const connect = attachments.connection(parent);

  useEffect(connect, [connect]);

  return {
    ...state.draft,
    ready: state.ready && !!parent,
    error: state.error,
    add: attachments.add,
    remove: attachments.remove,
    retry: attachments.retry,
    rememberSend: attachments.rememberSend,
    clear: attachments.clear,
  };
}
