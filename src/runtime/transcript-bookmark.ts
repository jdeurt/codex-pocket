import { type Virtualizer } from "@tanstack/react-virtual";
import { parseBookmark } from "../state/transcript-bookmark";
import { t } from "try";
import { EventBindings } from "./events";
import { clientError, reportClient } from "./client-logging";

export type { TranscriptBookmark } from "../state/transcript-bookmark";

/** Read browser storage inside the caller's error boundary.
@param key - Stable native conversation identity.
@returns Valid saved geometry or no saved bookmark.
*/
function storedBookmark(key: string) {
  return parseBookmark(sessionStorage.getItem(`pocket-scroll:${key}`));
}

/** Restore an optional bookmark and report storage failures while keeping the transcript usable.
@param key - Native conversation identity, absent for read-only views.
@returns Saved geometry or the default view when storage is unavailable.
*/
export function readTranscriptBookmark(key?: string) {
  if (!key || typeof window === "undefined") {
    return;
  }

  const restored = t(storedBookmark, key);

  if (!restored.ok) {
    reportClient("transcript.bookmark_restore_failed", clientError(restored.error), "error");

    return;
  }

  return restored.value;
}

/** Save the native layout without changing its scroll position.
@param key - Conversation identity.
@param virtualizer - Native owner of measurements and anchoring.
@param expanded - Activity disclosures corresponding to the measured rows.
*/
function storeBookmark(key: string, virtualizer: Virtualizer<HTMLDivElement, HTMLElement>, expanded: Set<string>) {
  const bookmark = {
    measurements: virtualizer.takeSnapshot(),
    offset: virtualizer.scrollOffset ?? 0,
    atEnd: virtualizer.isAtEnd(),
    expanded: [...expanded],
  };

  sessionStorage.setItem(`pocket-scroll:${key}`, JSON.stringify(bookmark));
}

/** Report persistence failure without interrupting page navigation.
@param key - Native conversation identity.
@param virtualizer - Native owner of current measurements.
@param expanded - Disclosures needed to restore the same geometry.
*/
function saveBookmark(key: string, virtualizer: Virtualizer<HTMLDivElement, HTMLElement>, expanded: Set<string>) {
  const saved = t(storeBookmark, key, virtualizer, expanded);

  if (!saved.ok) {
    reportClient("transcript.bookmark_save_failed", clientError(saved.error), "error");
  }
}

/** Capture a bookmark when the owning page navigates away.
@param key - Native conversation identity.
@param virtualizer - Native owner of measurements and scrolling.
@param expanded - Disclosures corresponding to measured rows.
@returns Cleanup for this exact page-lifecycle listener.
*/
export function subscribeTranscriptBookmark(
  key: string,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  expanded: Set<string>
) {
  return new EventBindings([[globalThis, "pagehide", saveBookmark.bind(undefined, key, virtualizer, expanded)]]).stop;
}
