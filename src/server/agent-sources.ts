import { type AgentRecord, type CodexThread, observedMetadata, nativeStatus } from "../state/agent-metadata";

export {
  type AgentRecord,
  type CodexThread,
  observedMetadata,
  nativeStatus,
  informationalRequest,
} from "../state/agent-metadata";
import { historyItems } from "../state/agent-history";
import { valueAfterCleanup } from "../lib/results";
import { log } from "./logging";
import { t as captureResult } from "try";
import { agentStatusSchema } from "../lib/agents";
import { object } from "../lib/protocol";
import { refreshCodexHistory, visiblePreview } from "./agent-history";
import { CodexRpc } from "./rpc";
import { type SidePocket } from "./delegations";
import { bridge } from "./bridge";
import { parentReaders } from "./pocket-readers";
import { readClaude } from "./agent-claude";
import { sessionAttachment } from "./session-adoption";

export { codexParent } from "../lib/codex";

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
@returns Updated immutable agent record or metadata.
*/
function observeRuntimeCodex(record: AgentRecord, owner: SidePocket) {
  const runtime = object(object(JSON.parse(owner.metadata)).nativeAgents);
  const observed = agentStatusSchema.safeParse(object(runtime[record.sessionId ?? ""]).status);

  return !observed.success || observed.data === "unknown"
    ? record
    : { ...record, agent: { ...record.agent, status: observed.data }, observedStatus: observed.data };
}

/**
Retain persisted child status and reconcile native descendants with their active owner's observations.
@param record - Scoped discovered Codex record whose display status is updated.
@returns Updated immutable agent record or metadata.
*/
export function observeCodex(record: AgentRecord) {
  if (record.pocket) {
    return record;
  }

  const next = {
    ...record,
    agent: {
      ...record.agent,
      status: nativeStatus(record.thread ?? { id: record.sessionId ?? "", turns: [] }, record.turns ?? []),
    },
  };

  return record.runtimeOwner && ["running", "waiting"].includes(record.runtimeOwner.status)
    ? observeRuntimeCodex(next, record.runtimeOwner)
    : next;
}

/**
Read native thread metadata and refresh its full cached history without resuming work.
@param record - Scoped discovery record receiving normalized history and metadata.
@param sessionId - Native session identity already checked by the hydration owner.
@param rpc - Native reader connected to the correct owning server.
@returns Updated immutable agent record or metadata.
*/
async function readCodexWithClient(record: AgentRecord, sessionId: string, rpc: CodexRpc) {
  const { thread } = await rpc.request("thread/read", {
    threadId: sessionId,
    includeTurns: false,
  });

  const turns = await refreshCodexHistory(rpc, thread, record.turns);

  return observeCodex({
    ...record,
    thread,
    turns,
    agent: { ...record.agent, ...observedMetadata({ model: thread.model, effort: thread.reasoningEffort }) },
  });
}

/**
Read live history from the owning socket without resuming or modifying the thread.
@param record - Parent-scoped adopted agent.
@param sessionId - Exact adopted native session.
@param socketPath - Original owning server's socket.
@returns Updated immutable agent record or metadata.
*/
async function readAttachedCodex(record: AgentRecord, sessionId: string, socketPath: string) {
  const rpc = new CodexRpc();

  const connected = await captureResult(rpc.connectSocket.bind(rpc), socketPath);
  const loaded = connected.ok ? await captureResult(readCodexWithClient, record, sessionId, rpc) : connected;
  const closed = await captureResult(rpc.shutdown.bind(rpc));
  const next = valueAfterCleanup(loaded, closed);

  return ["closing", "closed"].includes(next.pocket?.status ?? "")
    ? next
    : {
        ...next,
        agent: { ...next.agent, status: nativeStatus(next.thread ?? { id: sessionId, turns: [] }, next.turns ?? []) },
      };
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
@returns Updated immutable agent record or metadata.
*/
async function hydrateNativeAgent(record: AgentRecord) {
  const next = record.sessionId
    ? await (record.agent.harness === "codex"
        ? readCodex(record, record.sessionId)
        : readClaude(record, record.sessionId))
    : { ...record, turns: [] };

  return {
    ...next,
    historyError: false,
    agent: { ...next.agent, preview: visiblePreview(historyItems(next.turns ?? []).toReversed()) },
  };
}

/**
Retain saved data and expose availability failures when native history cannot be read.
@param record - Scoped discovery record whose history and availability are updated.
@returns Updated immutable agent record or metadata.
*/
export async function hydrateAgent(record: AgentRecord) {
  const completed = await captureResult(hydrateNativeAgent, record);

  if (completed.ok) {
    return completed.value;
  }

  log().warn({ err: completed.error, agent: record.agent.id }, "agents.history_failed");

  return {
    ...record,
    historyError: true,
    agent: {
      ...record.agent,
      status: !record.pocket || sessionAttachment(record.pocket.metadata) ? ("unknown" as const) : record.agent.status,
    },
  };
}
