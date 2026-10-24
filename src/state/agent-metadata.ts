import { type AgentEntry, type AgentStatus } from "../lib/agents";
import { type Data, type PendingRequest, type Thread, type Turn, object, string } from "../lib/protocol";
import type { SidePocket } from "../server/delegations";
import { codexActivity } from "../lib/codex";

const LAST_MESSAGE = -1;

export interface CodexThread extends Thread, Data {}
export interface AgentRecord {
  owner?: string;
  agent: AgentEntry;
  sessionId?: string;
  cwd: string;
  pocket?: SidePocket;
  runtimeOwner?: SidePocket;
  claudeRoot?: string;
  claudeAgent?: string;
  thread?: CodexThread;
  turns?: Turn[];
  requests?: PendingRequest[];
  historyError?: boolean;
  discoveryError?: boolean;
  observedStatus?: AgentStatus;
  ancestryKnown?: boolean;
  claudeParent?: string | null;
  fileRevision?: string;
}

/**
Project model and nullable reasoning effort from stored native metadata.
@param data - Normalized metadata object produced by the native harness.
@returns Only present model and effort fields, preserving explicit null effort.
*/
export function observedMetadata(data: Data) {
  return {
    ...(string(data.model) && { model: string(data.model) }),
    ...((typeof data.effort === "string" || data.effort === null) && { reasoningEffort: data.effort }),
  };
}

/**
Infer inactive native status from the last saved turn before the thread's idle fallback.
@param turns - Chronological native turns.
@param status - Native thread status discriminator.
@returns Existing failed, idle, completed or unknown catalog status.
*/
function settledStatus(turns: Turn[], status: unknown): AgentStatus {
  const last = turns.at(LAST_MESSAGE);

  if (last?.status === "failed") {
    return "failed";
  }

  if (last?.status === "interrupted") {
    return "idle";
  }

  if (last?.status === "completed") {
    return "completed";
  }

  return status === "idle" ? "idle" : "unknown";
}

/**
Prefer current native activity and system errors before saved-turn terminal status.
@param thread - Normalized native thread carrying its status and activity flags.
@param turns - Chronological turns available from lightweight or complete history.
@returns Existing read-only catalog status.
*/
export function nativeStatus(thread: CodexThread, turns: Turn[]): AgentStatus {
  const status = codexActivity(object(thread.status));

  return status === "idle" || status === "unknown" ? settledStatus(turns, status) : status;
}

/**
Project saved request details into read-only agent UI without dispatching an answer.
@param request - Persisted request with serialized native input.
@returns Informational normalized question or approval request.
*/
export function informationalRequest(request: { id: string; method: string; input: string }): PendingRequest {
  const input = object(JSON.parse(request.input));

  return {
    id: request.id,
    method: request.method,
    params: {
      ...(Array.isArray(input.questions) && { questions: input.questions }),
      ...(string(input.reason) && { reason: string(input.reason) }),
    },
  };
}
