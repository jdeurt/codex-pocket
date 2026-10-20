import { replayThreads, replayTurns } from "./agent-browser-data";
import { type Item } from "../../src/lib/protocol";

const PAGE_LIMIT = 20;

/**
Projects synthetic chronological native turns into the requested page and item-loading view.
@param params - Decoded native paging parameters.
@param state - Host-selected synthetic history stage.
@returns Native turn page and continuation cursor.
*/
export function pageTurns(params: Record<string, unknown>, state: string) {
  const turns = replayTurns(String(params.threadId), state);
  const ordered = params.sortDirection === "desc" ? turns.toReversed() : turns;
  const offset = Number(params.cursor ?? 0);
  const limit = Math.min(Number(params.limit ?? PAGE_LIMIT), PAGE_LIMIT);
  const page = {
    data: ordered.slice(offset, offset + limit).map((turn, index) => {
      if (params.itemsView === "notLoaded") {
        return { ...turn, items: [], itemsView: "notLoaded" };
      }

      return index === 0 && params.sortDirection !== "desc" ? { ...turn, items: [], itemsView: "summary" } : turn;
    }),
    nextCursor: offset + limit < ordered.length ? String(offset + limit) : null,
  };

  return page;
}

/**
Finds synthetic native metadata and optionally includes its canonical saved turns.
@param params - Decoded native thread lookup parameters.
@param state - Host-selected synthetic history stage.
@returns Saved native thread; the missing-session fixture throws.
*/
export function savedThread(params: Record<string, unknown>, state: string) {
  const thread = replayThreads(state === "settled", state === "history-changed" ? 2 : 1).find(
    (entry) => entry.id === params.threadId
  ) ?? {
    id: params.threadId,
    name: "Saved Side Pocket",
    model: "gpt-replay",
    reasoningEffort: "high",
  };

  if (params.threadId === "missing-session") {
    throw new Error("Synthetic missing session");
  }

  return { ...thread, turns: params.includeTurns ? replayTurns(String(params.threadId), state) : [] };
}

/**
Projects canonical saved native items into a bounded response page.
@param items - Canonical items from the requested saved turn or session.
@param params - Decoded native paging parameters.
@returns Native item-wrapper page and continuation cursor.
*/
export function pageItems(items: Item[], params: Record<string, unknown>) {
  const ordered = params.sortDirection === "desc" ? items.toReversed() : items;
  const offset = Number(params.cursor ?? 0);
  const limit = Math.min(Number(params.limit ?? 2), 2);

  return {
    data: ordered.slice(offset, offset + limit).map((item) => ({ item })),
    nextCursor: offset + limit < ordered.length ? String(offset + limit) : null,
  };
}

/**
Builds one active synthetic discovery page with native second-page cursor behavior.
@param params - Decoded native cursor parameters after the archived-list early return.
@param state - Host-selected native status and history revision.
@returns Synthetic native discovery page and continuation cursor.
*/
export function activeThreadPage(params: Record<string, unknown>, state: string) {
  const threads = replayThreads(state === "settled", state === "history-changed" ? 2 : 1);

  return params.cursor
    ? { data: threads.slice(2), nextCursor: null }
    : { data: threads.slice(0, 2), nextCursor: "second-page" };
}
