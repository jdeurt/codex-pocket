import { type CodexRpc, RpcError } from "./rpc";
import type { Snapshot, Thread, Turn } from "../lib/protocol";
import type { Config } from "./config";
import type { Receipt } from "./outbox";
import { attachmentInput } from "./uploads";

async function startTurn(rpc: CodexRpc, config: Config, state: Snapshot, input: unknown[], id: string) {
  const { turn } = await rpc.request<{ turn: Turn }>("turn/start", {
    threadId: config.threadId,
    input,
    clientUserMessageId: id,
    ...(state.reasoningEffort && { effort: state.reasoningEffort }),
  });

  if (
    turn.status === "inProgress" &&
    state.turns.every((entry) => entry.id !== turn.id || entry.status === "inProgress")
  ) {
    state.activeTurnId = turn.id;
  }
}

export async function deliverMessage(rpc: CodexRpc, config: Config, state: Snapshot, receipt: Receipt) {
  const input = [
    ...(receipt.text ? [{ type: "text", text: receipt.text, text_elements: [] }] : []),
    ...attachmentInput(config.threadId, receipt.attachments ?? []),
  ];

  if (!state.activeTurnId) {
    await startTurn(rpc, config, state, input, receipt.id);

    return;
  }

  try {
    await rpc.request("turn/steer", {
      threadId: config.threadId,
      expectedTurnId: state.activeTurnId,
      input,
      clientUserMessageId: receipt.id,
    });
  } catch (error) {
    // An explicit rejection is safe to recover. A timeout may already have delivered.
    if (!(error instanceof RpcError) || error.code === undefined) {
      throw error;
    }

    const { thread } = await rpc.request<{ thread: Thread }>("thread/read", {
      threadId: config.threadId,
      includeTurns: true,
    });
    const active = thread.turns.findLast((turn) => turn.status === "inProgress");

    if (active) {
      throw error;
    }

    state.activeTurnId = undefined;
    await startTurn(rpc, config, state, input, receipt.id);
  }
}
