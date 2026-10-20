import { type CodexRpc, RpcError } from "./rpc";
import { type Item, type Thread, type Turn } from "../lib/protocol";

const METHOD_NOT_FOUND = -32_601;

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

export async function loadHistory(rpc: CodexRpc, thread: Thread): Promise<Turn[]> {
  try {
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
  } catch (error) {
    if (!(error instanceof RpcError) || error.code !== METHOD_NOT_FOUND) {
      throw error;
    }

    const result = await rpc.request("thread/read", { threadId: thread.id, includeTurns: true });

    return result.thread.turns;
  }
}
