import { type CodexRpc, RpcError } from "./rpc";
import { type Item, type Thread, type Turn, object, string } from "../lib/protocol";
import { loadHistory, loadItems } from "./history";

const METHOD_NOT_FOUND = -32_601;
const TAIL_PAGE_SIZE = 10;
const MAX_PREVIEW_CHARACTERS = 1000;

export function visiblePreview(items: Item[]) {
  for (const item of items) {
    if (!["agentMessage", "userMessage"].includes(item.type)) {
      continue;
    }

    const text =
      string(item.text) ||
      (Array.isArray(item.content) ? item.content.map((part) => string(object(part).text)).join(" ") : "");

    if (text.trim()) {
      return text.replaceAll(/\s+/g, " ").trim().slice(0, MAX_PREVIEW_CHARACTERS);
    }
  }

  return "";
}

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
async function loadTail(rpc: CodexRpc, thread: Thread, previous: Turn[]) {
  const boundary = previous.findLast((turn) => ["completed", "failed", "interrupted"].includes(turn.status));
  const recent: Turn[] = [];
  let cursor: string | null = null;

  do {
    const page: { data: Turn[]; nextCursor: string | null } = await rpc.request("thread/turns/list", {
      threadId: thread.id,
      cursor,
      limit: TAIL_PAGE_SIZE,
      sortDirection: "desc",
      itemsView: "full",
    });

    for (const turn of page.data) {
      if (turn.itemsView && turn.itemsView !== "full") {
        turn.items = await loadItems(rpc, thread.id, turn.id);
      }

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

    cursor = page.nextCursor;
  } while (cursor);

  return recent.toReversed();
}

export async function refreshCodexHistory(rpc: CodexRpc, thread: Thread, previous?: Turn[]): Promise<Turn[]> {
  if (!previous?.length) {
    return loadHistory(rpc, thread);
  }

  try {
    return await loadTail(rpc, thread, previous);
  } catch (error) {
    if (!(error instanceof RpcError) || error.code !== METHOD_NOT_FOUND) {
      throw error;
    }

    return loadHistory(rpc, thread);
  }
}
