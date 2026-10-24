import { type CodexRpc, RpcError } from "./rpc";
import { type Item, type Thread, type Turn, object, string } from "../lib/protocol";
import { loadHistory, readHistoryTurns } from "./history";

const METHOD_NOT_FOUND = -32_601;
const TAIL_PAGE_SIZE = 10;
const MAX_PREVIEW_CHARACTERS = 1000;

/**
Read text only from native user and assistant messages, retaining the native content fallback.
@param item - Normalized native item from the requested preview page.
@returns Message text, or an empty string for non-message output.
*/
function visibleMessageText(item: Item) {
  if (!["agentMessage", "userMessage"].includes(item.type)) {
    return "";
  }

  return (
    string(item.text) ||
    (Array.isArray(item.content) ? item.content.map((part) => string(object(part).text)).join(" ") : "")
  );
}

/**
Select the first visible message text and bound its one-line catalog preview.
@param items - Normalized native items in the caller's requested preview order.
@returns Whitespace-normalized preview text, or an empty string when no visible message exists.
*/
export function visiblePreview(items: Item[]) {
  for (const item of items) {
    const text = visibleMessageText(item);

    if (text.trim()) {
      return text.replaceAll(/\s+/g, " ").trim().slice(0, MAX_PREVIEW_CHARACTERS);
    }
  }

  return "";
}

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
    const preview = visiblePreview(page.data.map((entry) => entry.item));

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
  const boundary = previous.findLast((turn) => ["completed", "failed", "interrupted"].includes(turn.status));
  const recent: Turn[] = [];

  for await (const turn of readHistoryTurns(rpc, thread.id, "desc", TAIL_PAGE_SIZE)) {
    recent.push(turn);

    if (turn.id === boundary?.id) {
      return [
        ...previous.slice(
          0,
          previous.findIndex((entry) => entry.id === boundary.id)
        ),
        ...recent.toReversed(),
      ];
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

  return (async () => loadTail(rpc, thread, previous))().catch((error: unknown) => {
    if (!(error instanceof RpcError) || error.code !== METHOD_NOT_FOUND) {
      throw error;
    }

    return loadHistory(rpc, thread);
  });
}
