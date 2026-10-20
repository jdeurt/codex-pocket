import { type AgentEntry, type AgentStatus, agentStatusSchema } from "../lib/agents";
import { type Data, type PendingRequest, type Thread, type Turn, object, string } from "../lib/protocol";
import { refreshCodexHistory, visiblePreview } from "./agent-history";
import { type SidePocket } from "./delegations";
import { bridge } from "./bridge";
import { readClaude } from "./agent-claude";

const LAST_MESSAGE = -1;

export interface CodexThread extends Thread, Data {}
export interface AgentRecord {
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
Resolve native Codex ancestry from explicit parent metadata rather than prompt text.
@param thread - Normalized native thread, including its SDK source metadata.
@returns Native parent identity, or an empty string when no ancestry is supplied.
*/
export function codexParent(thread: CodexThread) {
  const source = object(thread.source);
  const agent = object(source.subAgent);

  return string(thread.parentThreadId) || string(object(agent.thread_spawn).parent_thread_id);
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
  const status = object(thread.status);

  if (status.type === "active") {
    return Array.isArray(status.activeFlags) && status.activeFlags.length > 0 ? "waiting" : "running";
  }

  return status.type === "systemError" ? "failed" : settledStatus(turns, status.type);
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

/**
Read active and archived native subagent thread pages without hydrating transcripts.
@returns All lightweight native subagent threads in native page order.
*/
export async function codexThreads(): Promise<CodexThread[]> {
  const rpc = bridge.agentReader();
  const threads: CodexThread[] = [];

  for (const isArchived of [false, true]) {
    let cursor: string | null = null;

    do {
      const page: { data: CodexThread[]; nextCursor: string | null } = await rpc.request("thread/list", {
        sourceKinds: ["subAgent"],
        archived: isArchived,
        limit: 100,
        cursor,
      });

      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
  }

  return threads;
}

/**
Apply parent-observed native status only after its runtime ownership has been checked.
@param record - Discovered native child receiving observed status.
@param owner - Running or waiting Side Pocket that owns the native child.
*/
function observeRuntimeCodex(record: AgentRecord, owner: SidePocket) {
  const runtime = object(object(JSON.parse(owner.metadata)).nativeAgents);
  const observed = agentStatusSchema.safeParse(object(runtime[record.sessionId ?? ""]).status);

  if (!observed.success || observed.data === "unknown") {
    return;
  }

  record.agent.status = observed.data;
  record.observedStatus = observed.data;
}

/**
Retain persisted child status and reconcile native descendants with their active owner's observations.
@param record - Scoped discovered Codex record whose display status is updated.
*/
export function observeCodex(record: AgentRecord) {
  if (record.pocket) {
    return;
  }

  record.agent.status = nativeStatus(record.thread ?? { id: record.sessionId ?? "", turns: [] }, record.turns ?? []);

  if (!record.runtimeOwner || !["running", "waiting"].includes(record.runtimeOwner.status)) {
    return;
  }

  observeRuntimeCodex(record, record.runtimeOwner);
}

/**
Read native thread metadata and refresh its full cached history without resuming work.
@param record - Scoped discovery record receiving normalized history and metadata.
@param sessionId - Native session identity already checked by the hydration owner.
*/
async function readCodex(record: AgentRecord, sessionId: string) {
  const rpc = bridge.agentReader();
  const { thread } = await rpc.request("thread/read", {
    threadId: sessionId,
    includeTurns: false,
  });

  record.thread = thread;
  record.turns = await refreshCodexHistory(rpc, thread, record.turns);
  Object.assign(record.agent, observedMetadata({ model: thread.model, effort: thread.reasoningEffort }));

  observeCodex(record);
}

/**
Hydrate the selected native harness and derive a visible preview from canonical turns.
@param record - Scoped record whose native session may be absent.
*/
async function hydrateNativeAgent(record: AgentRecord) {
  if (record.sessionId) {
    await (record.agent.harness === "codex"
      ? readCodex(record, record.sessionId)
      : readClaude(record, record.sessionId));
  } else {
    record.turns = [];
  }

  record.agent.preview = visiblePreview((record.turns ?? []).flatMap((turn) => turn.items).toReversed());
  record.historyError = false;
}

/**
Retain saved data and expose availability failures when native history cannot be read.
@param record - Scoped discovery record whose history and availability are updated.
*/
export async function hydrateAgent(record: AgentRecord) {
  try {
    await hydrateNativeAgent(record);
  } catch {
    record.historyError = true;

    if (!record.pocket) {
      record.agent.status = "unknown";
    }
  }
}
