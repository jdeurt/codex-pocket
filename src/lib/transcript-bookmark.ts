import { type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
import { z } from "zod";
import { t as attempt } from "try";

const itemSchema = z.object({
  index: z.number(),
  start: z.number(),
  end: z.number(),
  size: z.number(),
  key: z.union([z.string(), z.number()]),
  lane: z.number(),
});
const bookmarkSchema = z.object({
  offset: z.number().nonnegative(),
  atEnd: z.boolean(),
  measurements: z.array(itemSchema),
  expanded: z.array(z.string()),
});

export type TranscriptBookmark = z.infer<typeof bookmarkSchema>;

/** Validate optional serialized native measurements without coercion.
@param source - Optional browser-storage value.
@returns Valid saved geometry, or no bookmark when absent.
*/
function parseBookmark(source: string | null) {
  return source ? bookmarkSchema.parse(JSON.parse(source)) : undefined;
}

/** Read this tab's saved native virtualizer snapshot for one parent.
@param key - Stable native parent identity, absent for read-only child views.
@returns A validated bookmark, or no bookmark when storage is unavailable.
*/
export function readTranscriptBookmark(key?: string) {
  if (!key || typeof sessionStorage === "undefined") {
    return;
  }

  return attempt(parseBookmark, sessionStorage.getItem(`pocket-scroll:${key}`)).value;
}

/** Save documented TanStack measurements and offset without inventing scroll adjustments.
@param key - Stable native parent identity.
@param measurements - Documented takeSnapshot result from the native virtualizer.
@param offset - Current native scroll offset.
@param isAtEnd - Whether this parent should follow new work when reopened.
@param expanded - Activity disclosures needed to restore the same row geometry.
*/
function saveTranscriptBookmark(
  key: string,
  measurements: VirtualItem[],
  offset: number,
  isAtEnd: boolean,
  expanded: Set<string>
) {
  const bookmark = { measurements, offset, atEnd: isAtEnd, expanded: [...expanded] };

  /*
    Storage is optional; native anchoring still owns the current view.
    */
  void attempt(() => {
    sessionStorage.setItem(`pocket-scroll:${key}`, JSON.stringify(bookmark));
  });
}

/** Capture the documented native bookmark when this tab navigates away.
@param key - Native parent identity whose reading position is retained.
@param virtualizer - Existing TanStack owner, without additional scroll control.
@param expanded - Activity disclosure state corresponding to measured rows.
@returns Cleanup for this page-lifecycle subscription.
*/
export function subscribeTranscriptBookmark(
  key: string,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  expanded: Set<string>
) {
  const save = () => {
    saveTranscriptBookmark(
      key,
      virtualizer.takeSnapshot(),
      virtualizer.scrollOffset ?? 0,
      virtualizer.isAtEnd(),
      expanded
    );
  };

  globalThis.addEventListener("pagehide", save);

  return () => {
    globalThis.removeEventListener("pagehide", save);
  };
}
