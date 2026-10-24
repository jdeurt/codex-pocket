import { t as captureResult } from "try";
import { type CodexRpc, RpcError } from "./rpc";
import { type Item, type Thread, type Turn } from "../lib/protocol";

const METHOD_NOT_FOUND = -32_601;
const HISTORY_PAGE_SIZE = 100;

/**
Read every native item page for a deferred turn in ascending order.
@param rpc - Connected native Codex reader.
@param threadId - Thread owning the requested turn.
@param turnId - Turn whose complete items are requested.
@returns All native items in chronological order.
*/
export async function loadItems(rpc: CodexRpc, threadId: string, turnId: string) {
  const items: Item[] = [];

  let cursor: string | null = null;

  do {
    const page: { data: { item: Item }[]; nextCursor: string | null } = await rpc.request("thread/items/list", {
      threadId,
      turnId,
      cursor,
      limit: 100,
      sortDirection: "asc",
    });

    for (const entry of page.data) {
      items.push(entry.item);
    }

    cursor = page.nextCursor;
  } while (cursor);

  return items;
}

/**
Read native turn pages, hydrating each turn only when the caller advances to it.
@param rpc - Connected native Codex protocol client.
@param threadId - Thread whose saved history is requested.
@param sortDirection - Native traversal order required by the reader.
@param limit - Reader's existing native page size.
@yields One hydrated turn in native traversal order.
*/
export async function* readHistoryTurns(rpc: CodexRpc, threadId: string, sortDirection: "asc" | "desc", limit: number) {
  let cursor: string | null = null;

  do {
    const page: { data: Turn[]; nextCursor: string | null } = await rpc.request("thread/turns/list", {
      threadId,
      cursor,
      limit,
      sortDirection,
      itemsView: "full",
    });

    for (const turn of page.data) {
      yield turn.itemsView && turn.itemsView !== "full"
        ? { ...turn, items: await loadItems(rpc, threadId, turn.id) }
        : turn;
    }

    cursor = page.nextCursor;
  } while (cursor);
}

/**
Read the legacy native thread response when paginated history is unavailable.
@param rpc - Connected Codex client using the older history protocol.
@param thread - Thread identity whose turns must be recovered.
@returns Native saved turns without replaying work.
*/
async function legacyHistory(rpc: CodexRpc, thread: Thread) {
  const result = await rpc.request("thread/read", { threadId: thread.id, includeTurns: true });

  return result.thread.turns;
}

/**
Load complete native history, falling back only when the paginated method is unsupported.
@param rpc - Connected native protocol client.
@param thread - Thread whose saved history is requested.
@returns All hydrated turns, preserving native ordering.
*/
export async function loadHistory(rpc: CodexRpc, thread: Thread): Promise<Turn[]> {
  const completed = await captureResult(Array.fromAsync(readHistoryTurns(rpc, thread.id, "asc", HISTORY_PAGE_SIZE)));

  if (completed.ok) {
    return completed.value;
  }

  const error = completed.error;

  if (!(error instanceof RpcError) || error.code !== METHOD_NOT_FOUND) {
    throw error;
  }

  return legacyHistory(rpc, thread);
}
