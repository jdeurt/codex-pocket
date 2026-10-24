import { visiblePreview } from "../state/agent-history";

export { visiblePreview } from "../state/agent-history";
import { t as captureResult } from "try";
import { type CodexRpc, RpcError } from "./rpc";
import { type Item, type Thread, type Turn } from "../lib/protocol";
import { loadHistory, readHistoryTurns } from "./history";

/** Read a native page entry.
@param entry - One native item page entry.
@returns Its canonical item.
*/
function pageItem(entry: { item: Item }) {
  return entry.item;
}

const METHOD_NOT_FOUND = -32_601;
const TAIL_PAGE_SIZE = 10;

/**
Read native turn metadata and search descending item pages for visible preview text.
@param rpc - Connected native Codex reader.
@param threadId - Scoped thread whose lightweight preview is requested.
@returns Visible preview text and the native summary turn page.
*/
export async function codexPreview(rpc: CodexRpc, threadId: string) {
  const summary = await rpc.request("thread/turns/list", {
    threadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });

  let cursor: string | null = null;

  do {
    const page: { data: { item: Item }[]; nextCursor: string | null } = await rpc.request("thread/items/list", {
      threadId,
      cursor,
      limit: 50,
      sortDirection: "desc",
    });
    const preview = visiblePreview(Array.from(page.data, pageItem));

    if (preview || !page.nextCursor) {
      return { preview, turns: summary.data };
    }

    cursor = page.nextCursor;
  } while (cursor);

  return { preview: "", turns: summary.data };
}

// Re-read the live tail, including edits to the last settled turn. Older turns
// remain cached. A rollback/deletion that removes the boundary rebuilds history.
/**
Refresh recent turn pages through the last settled cached boundary.
@param rpc - Connected native Codex reader.
@param thread - Thread whose latest turns may have changed.
@param previous - Previously hydrated chronological turns retained before the settled boundary.
@returns Chronological history with the live tail replaced, or rebuilt history if the boundary disappeared.
*/
async function loadTail(rpc: CodexRpc, thread: Thread, previous: Turn[]) {
  let boundary: Turn | undefined;

  for (const turn of previous) {
    if (["completed", "failed", "interrupted"].includes(turn.status)) {
      boundary = turn;
    }
  }

  const recent: Turn[] = [];

  for await (const turn of readHistoryTurns(rpc, thread.id, "desc", TAIL_PAGE_SIZE)) {
    recent.push(turn);

    if (turn.id === boundary?.id) {
      return [...previous.slice(0, previous.indexOf(boundary)), ...recent.toReversed()];
    }
  }

  return recent.toReversed();
}

/**
Refresh a cached native history tail, using full history when no usable boundary or method exists.
@param rpc - Connected native Codex reader.
@param thread - Scoped thread to read.
@param previous - Previously hydrated chronological turns, when cached.
@returns Complete chronological history without replaying any turn.
*/
export async function refreshCodexHistory(rpc: CodexRpc, thread: Thread, previous?: Turn[]): Promise<Turn[]> {
  if (!previous?.length) {
    return loadHistory(rpc, thread);
  }

  const completed = await captureResult(loadTail(rpc, thread, previous));

  if (completed.ok) {
    return completed.value;
  }

  const error = completed.error;

  if (!(error instanceof RpcError) || error.code !== METHOD_NOT_FOUND) {
    throw error;
  }

  return loadHistory(rpc, thread);
}
