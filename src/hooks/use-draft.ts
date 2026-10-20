"use client";
import { useSyncExternalStore } from "react";

const memory = { draft: "" };
const key = "codex-pocket-draft";
const draftEvent = "codex-pocket-draft-updated";

/**
Observe same-tab and cross-tab draft changes using the caller's stable listener.
@param listener - React external-store callback to register and later remove.
@returns Cleanup for both native event subscriptions.
*/
function subscribe(listener: () => void) {
  globalThis.addEventListener(draftEvent, listener);
  globalThis.addEventListener("storage", listener);

  return () => {
    globalThis.removeEventListener(draftEvent, listener);
    globalThis.removeEventListener("storage", listener);
  };
}

/**
Read stored draft text, falling back to memory only when browser storage is unavailable.
@returns Stored text or null for a missing key, with memory used after a storage exception.
*/
function storedDraftText() {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.draft;
  }
}

/**
Normalize a missing storage key to the composer's empty-string value.
@returns Current draft text without trimming or conversion.
*/
const getSnapshot = () => storedDraftText() ?? "";

/**
Provide the stable empty draft used before the browser store is available.
@returns An empty string for server rendering.
*/
const getServerSnapshot = () => "";

/**
Update the exact local draft and notify every active draft subscriber.
@param value - New composer text, including its original whitespace.
*/
const setDraft = (value: string) => {
  memory.draft = value;

  try {
    localStorage.setItem(key, value);
  } catch {
    /*
    Storage can be unavailable in private browsing.
    */
  }

  globalThis.dispatchEvent(new Event(draftEvent));
};

/**
Subscribe the composer to its durable browser draft and in-memory storage fallback.
@returns The current text and stable update operation.
*/
export function useDraft() {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return [value, setDraft] as const;
}
