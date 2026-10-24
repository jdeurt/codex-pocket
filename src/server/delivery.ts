import { t as captureResult } from "try";
import { type CodexRpc, RpcError } from "./rpc";
import { type Config } from "./config";
import { type Receipt } from "./outbox";
import { type Snapshot, type Turn, hasActiveTurn } from "../lib/protocol";
import { type BridgeSnapshots } from "./bridge-snapshots";
import { findById } from "../lib/identity";
import { attachmentInput } from "./uploads";
import { internalContext, parentInput } from "./internal-context";

/** Preserve a completion event that arrived before the native start response.
@param state - Latest canonical snapshot.
@param turn - Returned native turn.
@returns Whether the response still represents active work.
*/
function canActivateTurn(state: Snapshot, turn: Turn) {
  const existing = findById(state.turns, turn.id);

  return turn.status === "inProgress" && (!existing || existing.status === "inProgress");
}

/** Mark generated attachment metadata as internal model context.
@param part - Explicit prepared native attachment input.
@returns Model input preserving native file/image fields.
*/
function internalAttachment(part: ReturnType<typeof attachmentInput>[number]) {
  return typeof part.text === "string" ? { ...part, text: internalContext("attachment_metadata", part.text) } : part;
}

/**
Start one native turn and record its active identity only while native state agrees.
@param rpc - Connected native Codex client.
@param config - Validated parent configuration.
@param owner - Canonical snapshot runtime, reread after native work.
@param input - Prepared text and original attachment inputs.
@param id - Stable client receipt identity for native delivery.
*/
async function startTurn(rpc: CodexRpc, config: Config, owner: BridgeSnapshots, input: unknown[], id: string) {
  const state = owner.state;
  const { turn } = await rpc.request("turn/start", {
    threadId: config.threadId,
    input,
    clientUserMessageId: id,
    ...(state.reasoningEffort && { effort: state.reasoningEffort }),
  });

  if (canActivateTurn(owner.state, turn)) {
    owner.state = { ...owner.state, activeTurnId: turn.id };
  }
}

/**
Recover an explicitly rejected steer only after a native read proves no turn remains active.
@param rpc - Connected native client that rejected steering.
@param config - Validated parent configuration.
@param owner - Canonical snapshot runtime, reread after native work.
@param input - Prepared text and original attachment inputs, unchanged from the rejected attempt.
@param id - Stable receipt identity reused for the recovered start.
@param rejection - Explicit native rejection that remains authoritative if a turn is active.
*/
async function recoverRejectedSteer(
  rpc: CodexRpc,
  config: Config,
  owner: BridgeSnapshots,
  input: unknown[],
  id: string,
  rejection: RpcError
) {
  const { thread } = await rpc.request("thread/read", { threadId: config.threadId, includeTurns: true });
  const isActive = hasActiveTurn(thread.turns);

  if (isActive) {
    throw rejection;
  }

  owner.state = { ...owner.state, activeTurnId: undefined };
  await startTurn(rpc, config, owner, input, id);
}

/**
Start or steer a persisted receipt, recovering only an explicit inactive-turn rejection.
@param rpc - Connected native Codex client.
@param config - Validated parent configuration.
@param owner - Canonical snapshot runtime.
@param receipt - Persisted message with original attachment metadata.
*/
export async function deliverMessage(rpc: CodexRpc, config: Config, owner: BridgeSnapshots, receipt: Receipt) {
  const state = owner.state;
  const text = parentInput(receipt, state);
  const input = [
    ...(text ? [{ type: "text", text, text_elements: [] }] : []),
    ...(receipt.voiceContext
      ? [{ type: "text", text: internalContext("voice_conversation", receipt.voiceContext.text), text_elements: [] }]
      : []),
    ...Array.from(attachmentInput(config.threadId, receipt.attachments ?? []), internalAttachment),
  ];

  if (!state.activeTurnId) {
    await startTurn(rpc, config, owner, input, receipt.id);

    return;
  }

  const completed = await captureResult(
    rpc.request("turn/steer", {
      threadId: config.threadId,
      expectedTurnId: state.activeTurnId,
      input,
      clientUserMessageId: receipt.id,
    })
  );

  if (completed.ok) {
    return;
  }

  const error = completed.error;

  // An explicit rejection is safe to recover. A timeout may already have delivered.
  if (!(error instanceof RpcError) || error.code === undefined) {
    throw error;
  }

  await recoverRejectedSteer(rpc, config, owner, input, receipt.id, error);
}
