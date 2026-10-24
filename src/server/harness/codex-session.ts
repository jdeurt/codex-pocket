import { t as captureResult } from "try";
import { type AdapterOptions } from "./types";
import { type CodexRpc, RpcError } from "../rpc";
import { type SessionResponse } from "../rpc-protocol";

const INVALID_REQUEST_CODE = -32_600;

/** Resume a saved child or replace only a known never-started empty session.
@param rpc - Child-owned native connection.
@param child - Durable delegation identity and receipt state.
@param params - Inherited native session settings.
@returns The validated native session response.
*/
export async function restoreCodexThread(
  rpc: CodexRpc,
  child: AdapterOptions["child"],
  params: Record<string, unknown>
): Promise<SessionResponse> {
  if (!child.sessionId) {
    return rpc.request("thread/start", params);
  }

  const completed = await captureResult(rpc.request("thread/resume", { ...params, threadId: child.sessionId }));

  if (completed.ok) {
    return completed.value;
  }

  const error = completed.error;

  if (
    !(error instanceof RpcError) ||
    error.code !== INVALID_REQUEST_CODE ||
    child.sessionStarted !== false ||
    !error.message.startsWith("no rollout found for thread id ")
  ) {
    throw error;
  }

  // Codex does not persist an empty thread. Only replace a session known to have received no input.
  return rpc.request("thread/start", params);
}
