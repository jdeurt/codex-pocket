import { type CodexRpc, RpcError } from "./rpc";
import { type Item, type Thread, type Turn } from "../lib/protocol";

const METHOD_NOT_FOUND = -32_601;

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

    items.push(...page.data.map((entry) => entry.item));
    cursor = page.nextCursor;
  } while (cursor);

  return items;
}

/**
Read full turn pages in native chronological order, filling deferred item pages before returning.
@param rpc - Connected native Codex protocol client.
@param thread - Thread whose entire saved history is requested.
@returns Hydrated turns in chronological order.
*/
async function loadTurns(rpc: CodexRpc, thread: Thread): Promise<Turn[]> {
  const turns: Turn[] = [];

  let cursor: string | null = null;

  do {
    const page: { data: Turn[]; nextCursor: string | null } = await rpc.request("thread/turns/list", {
      threadId: thread.id,
      cursor,
      limit: 100,
      sortDirection: "asc",
      itemsView: "full",
    });

    for (const turn of page.data) {
      if (turn.itemsView && turn.itemsView !== "full") {
        turn.items = await loadItems(rpc, thread.id, turn.id);
      }

      turns.push(turn);
    }

    cursor = page.nextCursor;
  } while (cursor);

  return turns;
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
  try {
    return await loadTurns(rpc, thread);
  } catch (error) {
    if (!(error instanceof RpcError) || error.code !== METHOD_NOT_FOUND) {
      throw error;
    }

    return legacyHistory(rpc, thread);
  }
}
