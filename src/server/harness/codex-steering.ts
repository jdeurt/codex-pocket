import { type CodexRpc, RpcError } from "../rpc";
import { type SteeringResult } from "./types";
import { steerResponseSchema } from "../rpc-protocol";

const METHOD_NOT_FOUND = -32_601;

/**
Inspect native session state only after a response proves the correction was rejected.
@param rpc - Owned native session connection.
@param sessionId - Same saved child, without forking or replacing its identity.
@param detail - Original explicit native rejection.
@returns Failed while any native turn remains active, otherwise safe idle resumption.
*/
async function inspectRejection(rpc: CodexRpc, sessionId: string, detail: string): Promise<SteeringResult> {
  const { thread } = await rpc.request("thread/read", { threadId: sessionId, includeTurns: true });

  return thread.turns.some((turn) => turn.status === "inProgress")
    ? { status: "failed", detail }
    : { status: "idle", detail: "Native steering was rejected and no turn is active. Nothing was accepted." };
}

/**
Classify a native rejection separately from a lost acknowledgement; only confirmed idle permits resumption.
@param rpc - Owned native session connection.
@param sessionId - Saved child identity to inspect after an explicit rejection.
@param error - Native rejection or transport failure from this single send attempt.
@returns Explicit unsupported, failed, idle, or unknown outcome; never retries the send.
*/
async function rejected(rpc: CodexRpc, sessionId: string, error: unknown): Promise<SteeringResult> {
  if (!(error instanceof RpcError) || error.code === undefined) {
    return {
      status: "unknown",
      detail: `Native steering could not be verified: ${error instanceof Error ? error.message : String(error)}. Inspect history before retrying.`,
    };
  }

  return error.code === METHOD_NOT_FOUND
    ? { status: "unsupported", detail: error.message }
    : inspectRejection(rpc, sessionId, error.message);
}

/**
Validate the native acknowledgement without claiming the model has consumed the correction.
@param rpc - Owned active native transport.
@param sessionId - Saved child identity.
@param expectedTurnId - Exact active turn this correction is permitted to affect.
@param id - Durable message identity recorded before transport submission.
@param input - Exact current-task correction.
@returns Accepted only when the response names the expected native turn.
*/
async function accepted(
  rpc: CodexRpc,
  sessionId: string,
  expectedTurnId: string,
  id: string,
  input: string
): Promise<SteeringResult> {
  const response = steerResponseSchema.parse(
    await rpc.request("turn/steer", {
      threadId: sessionId,
      expectedTurnId,
      clientUserMessageId: id,
      input: [{ type: "text", text: input, text_elements: [] }],
    })
  );

  return response.turnId === expectedTurnId
    ? { status: "accepted", turnId: response.turnId }
    : { status: "unknown", detail: "Native acknowledgement named a different turn. Inspect history; do not retry." };
}

/**
Attempt native steering once, preserving expected-turn identity and the durable client message ID.
@param rpc - Native connection already executing the child's current task.
@param sessionId - Saved native session identity.
@param expectedTurnId - Active turn obtained from native start acknowledgement or notification.
@param id - Durable client message identity used for correlation, never assumed to guarantee native deduplication.
@param input - Current-task correction without model, permissions or other turn-level overrides.
@returns Native acceptance, explicit rejection, unsupported capability, or uncertain outcome.
*/
export async function steerCodex(
  rpc: CodexRpc,
  sessionId: string | undefined,
  expectedTurnId: string | undefined,
  id: string,
  input: string
): Promise<SteeringResult> {
  if (!sessionId || !expectedTurnId) {
    return { status: "idle", detail: "The native turn ended before steering was attempted. Nothing was sent." };
  }

  return accepted(rpc, sessionId, expectedTurnId, id, input).catch((error: unknown) => {
    return rejected(rpc, sessionId, error);
  });
}
