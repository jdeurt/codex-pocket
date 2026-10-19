"use client";
import { useSyncExternalStore } from "react";

const memory = { draft: "" };
const key = "codex-pocket-draft";
const draftEvent = "codex-pocket-draft-updated";

function subscribe(listener: () => void) {
  globalThis.addEventListener(draftEvent, listener);
  globalThis.addEventListener("storage", listener);

  return () => {
    globalThis.removeEventListener(draftEvent, listener);
    globalThis.removeEventListener("storage", listener);
  };
}

const getSnapshot = () => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return memory.draft;
  }
};
const getServerSnapshot = () => "";
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
export function useDraft() {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return [value, setDraft] as const;
}
