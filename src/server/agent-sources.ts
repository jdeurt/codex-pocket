import { type AgentEntry, type AgentStatus, agentStatusSchema } from "../lib/agents";
import { type Data, type PendingRequest, type Thread, type Turn, object, string } from "../lib/protocol";
import { refreshCodexHistory, visiblePreview } from "./agent-history";
import { CodexRpc } from "./rpc";
import { type SidePocket } from "./delegations";
import { bridge } from "./bridge";
import { codexActivity } from "../lib/codex";
import { parentReaders } from "./pocket-readers";
import { readClaude } from "./agent-claude";
import { sessionAttachment } from "./session-adoption";

export { codexParent } from "../lib/codex";

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

/**
Read active and archived native subagent thread pages without hydrating transcripts.
@param owner - Verified parent whose native reader owns this query.
@returns All lightweight native subagent threads in native page order.
*/
export async function codexThreads(owner = ""): Promise<CodexThread[]> {
  const rpc = (parentReaders.get(owner) ?? bridge).agentReader();
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
@param rpc - Native reader connected to the correct owning server.
*/
async function readCodexWithClient(record: AgentRecord, sessionId: string, rpc: CodexRpc) {
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
Read live history from the owning socket without resuming or modifying the thread.
@param record - Parent-scoped adopted agent.
@param sessionId - Exact adopted native session.
@param socketPath - Original owning server's socket.
*/
async function readAttachedCodex(record: AgentRecord, sessionId: string, socketPath: string) {
  const rpc = new CodexRpc();

  await (async () => {
    await rpc.connectSocket(socketPath);
    await readCodexWithClient(record, sessionId, rpc);
  })().finally(async () => {
    await rpc.shutdown();
  });

  if (!["closing", "closed"].includes(record.pocket?.status ?? "")) {
    record.agent.status = nativeStatus(record.thread ?? { id: sessionId, turns: [] }, record.turns ?? []);
  }
}

/**
Choose the stored owning connection for adopted live sessions and the parent reader otherwise.
@param record - Scoped agent with validated durable ownership.
@param sessionId - Native thread to display.
@returns Completion of the canonical native history read.
*/
function readCodex(record: AgentRecord, sessionId: string) {
  const attachment = record.pocket ? sessionAttachment(record.pocket.metadata) : undefined;

  return attachment
    ? readAttachedCodex(record, sessionId, attachment.socketPath)
    : readCodexWithClient(record, sessionId, (parentReaders.get(record.owner ?? "") ?? bridge).agentReader());
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
  await (async () => hydrateNativeAgent(record))().catch(() => {
    record.historyError = true;

    if (!record.pocket || sessionAttachment(record.pocket.metadata)) {
      record.agent.status = "unknown";
    }
  });
}
