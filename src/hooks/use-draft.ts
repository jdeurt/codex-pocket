"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { selectedPocketId } from "@/lib/pockets";

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
  const storageKey = selectedPocketId() === "main" ? key : `${key}:${selectedPocketId()}`;

  try {
    return localStorage.getItem(storageKey);
  } catch {
    return memory.draft;
  }
}

/**
Confirm the composer text is durable before an automatic release refresh.
@param value - Current composer text, including restored drafts.
@returns Whether reloading can recover the exact in-memory draft.
*/
export function isDraftSaved(value: string) {
  const storageKey = selectedPocketId() === "main" ? key : `${key}:${selectedPocketId()}`;

  let persisted: string | null;

  try {
    persisted = localStorage.getItem(storageKey);
  } catch {
    return value === "";
  }

  return (persisted ?? "") === value;
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
  const storageKey = selectedPocketId() === "main" ? key : `${key}:${selectedPocketId()}`;

  memory.draft = value;

  try {
    localStorage.setItem(storageKey, value);
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

/**
Recover a persisted uncertain send once without replacing a newer local draft.
@param pending - Durable outbound record awaiting reconciliation.
@param draft - Current composer text.
@param isSending - Whether a new send currently owns the composer.
@param update - Stable draft setter.
*/
export function useRecoveredDraft(
  pending: { id: string; text: string } | null | undefined,
  draft: string,
  isSending: boolean,
  update: (value: string) => void
) {
  const recovered = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!pending || recovered.current === pending.id) {
      return;
    }

    recovered.current = pending.id;

    if (!draft && !isSending) {
      update(pending.text);
    }
  }, [pending, draft, isSending, update]);
}
