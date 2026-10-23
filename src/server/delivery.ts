import { type CodexRpc, RpcError } from "./rpc";
import { type Config } from "./config";
import { type Receipt } from "./outbox";
import { type Snapshot } from "../lib/protocol";
import { attachmentInput } from "./uploads";
import { internalContext, parentInput } from "./internal-context";

/**
Start one native turn and record its active identity only while native state agrees.
@param rpc - Connected native Codex client.
@param config - Validated parent configuration.
@param state - Current parent snapshot updated by native events.
@param input - Prepared text and original attachment inputs.
@param id - Stable client receipt identity for native delivery.
*/
async function startTurn(rpc: CodexRpc, config: Config, state: Snapshot, input: unknown[], id: string) {
  const { turn } = await rpc.request("turn/start", {
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

/**
Recover an explicitly rejected steer only after a native read proves no turn remains active.
@param rpc - Connected native client that rejected steering.
@param config - Validated parent configuration.
@param state - Canonical snapshot whose inactive-turn identity may be cleared.
@param input - Prepared text and original attachment inputs, unchanged from the rejected attempt.
@param id - Stable receipt identity reused for the recovered start.
@param rejection - Explicit native rejection that remains authoritative if a turn is active.
*/
async function recoverRejectedSteer(
  rpc: CodexRpc,
  config: Config,
  state: Snapshot,
  input: unknown[],
  id: string,
  rejection: RpcError
) {
  const { thread } = await rpc.request("thread/read", { threadId: config.threadId, includeTurns: true });
  const isActive = thread.turns.some((turn) => turn.status === "inProgress");

  if (isActive) {
    throw rejection;
  }

  state.activeTurnId = undefined;
  await startTurn(rpc, config, state, input, id);
}

/**
Start or steer a persisted receipt, recovering only an explicit inactive-turn rejection.
@param rpc - Connected native Codex client.
@param config - Validated parent configuration.
@param state - Current snapshot owning the active turn identity.
@param receipt - Persisted message with original attachment metadata.
*/
export async function deliverMessage(rpc: CodexRpc, config: Config, state: Snapshot, receipt: Receipt) {
  const text = parentInput(receipt, state);
  const input = [
    ...(text ? [{ type: "text", text, text_elements: [] }] : []),
    ...attachmentInput(config.threadId, receipt.attachments ?? []).map((part) =>
      "text" in part ? { ...part, text: internalContext("attachment_metadata", part.text) } : part
    ),
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

    await recoverRejectedSteer(rpc, config, state, input, receipt.id, error);
  }
}
