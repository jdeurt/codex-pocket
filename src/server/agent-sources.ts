import { type AgentEntry, type AgentStatus, activeAgent, agentStatusSchema } from "../lib/agents";
import { type ClaudeMessage, claudeTranscript } from "./harness/transcript";
import { type Data, type PendingRequest, type Thread, type Turn, object, string } from "../lib/protocol";
import { getSessionInfo, getSessionMessages, getSubagentMessages, listSubagents } from "@anthropic-ai/claude-agent-sdk";
import { refreshCodexHistory, visiblePreview } from "./agent-history";
import { type SidePocket } from "./delegations";
import { agentRead } from "./agent-read-pool";
import { bridge } from "./bridge";

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

export function codexParent(thread: CodexThread) {
  return (
    string(thread.parentThreadId) ||
    string(object(object(object(thread.source).subAgent).thread_spawn).parent_thread_id)
  );
}

export function observedMetadata(data: Data) {
  return {
    ...(string(data.model) && { model: string(data.model) }),
    ...((typeof data.effort === "string" || data.effort === null) && { reasoningEffort: data.effort }),
  };
}

export function nativeStatus(thread: CodexThread, turns: Turn[]): AgentStatus {
  const status = object(thread.status);

  if (status.type === "active") {
    return Array.isArray(status.activeFlags) && status.activeFlags.length > 0 ? "waiting" : "running";
  }

  if (status.type === "systemError") {
    return "failed";
  }

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

  return status.type === "idle" ? "idle" : "unknown";
}

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

export async function codexThreads(): Promise<CodexThread[]> {
  const rpc = bridge.agentReader();
  const threads: CodexThread[] = [];

  for (const archived of [false, true]) {
    let cursor: string | null = null;

    do {
      const page: { data: CodexThread[]; nextCursor: string | null } = await rpc.request("thread/list", {
        sourceKinds: ["subAgent"],
        archived,
        limit: 100,
        cursor,
      });
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
  }

  return threads;
}

export function observeCodex(record: AgentRecord) {
  if (record.pocket) {
    return;
  }

  record.agent.status = nativeStatus(record.thread ?? { id: record.sessionId ?? "", turns: [] }, record.turns ?? []);

  if (!record.runtimeOwner || !["running", "waiting"].includes(record.runtimeOwner.status)) {
    return;
  }

  const runtime = object(object(JSON.parse(record.runtimeOwner.metadata)).nativeAgents);
  const observed = agentStatusSchema.safeParse(object(runtime[record.sessionId ?? ""]).status);

  if (!observed.success || observed.data === "unknown") {
    return;
  }

  record.agent.status = observed.data;
  record.observedStatus = observed.data;
}

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

async function readClaude(record: AgentRecord, sessionId: string) {
  const messages = record.claudeAgent
    ? await getSubagentMessages(record.claudeRoot ?? sessionId, record.claudeAgent, { dir: record.cwd })
    : await getSessionMessages(sessionId, { dir: record.cwd });

  if (record.pocket && messages.length === 0 && !(await getSessionInfo(sessionId, { dir: record.cwd }))) {
    throw new Error("Saved Claude history is unavailable.");
  }

  record.turns = claudeTranscript(messages);
  const model = messages.map((message) => string(object(message.message).model)).findLast(Boolean);

  if (model) {
    record.agent.model = model;
  }

  if (record.pocket) {
    return;
  }

  const last = object(messages.at(LAST_MESSAGE)?.message);
  record.agent.status =
    record.observedStatus ??
    (["end_turn", "stop_sequence"].includes(string(last.stop_reason))
      ? "completed"
      : last.stop_reason === "max_tokens"
        ? "idle"
        : "unknown");
}

export async function hydrateAgent(record: AgentRecord) {
  try {
    if (record.sessionId) {
      await (record.agent.harness === "codex"
        ? readCodex(record, record.sessionId)
        : readClaude(record, record.sessionId));
    } else {
      record.turns = [];
    }

    record.agent.preview = visiblePreview((record.turns ?? []).flatMap((turn) => turn.items).toReversed());
    record.historyError = false;
  } catch {
    record.historyError = true;

    if (!record.pocket) {
      record.agent.status = "unknown";
    }
  }
}
export async function claudeChildren(
  parent: AgentRecord,
  previous = new Map<string, AgentRecord>()
): Promise<AgentRecord[]> {
  if (!parent.sessionId) {
    return [];
  }

  const runtime = object(object(parent.pocket ? JSON.parse(parent.pocket.metadata) : {}).nativeAgents);
  const ids = [...new Set([...(await listSubagents(parent.sessionId, { dir: parent.cwd })), ...Object.keys(runtime)])];
  const messages = new Map<string, ClaudeMessage[]>();

  await Promise.all(
    ids.map(async (id) => {
      const saved = previous.get(`claude:${parent.sessionId ?? ""}:${id}`);

      if (Object.hasOwn(runtime, id) || saved?.ancestryKnown) {
        return;
      }

      messages.set(
        id,
        await agentRead(() => getSubagentMessages(parent.sessionId ?? "", id, { dir: parent.cwd, limit: 1 }), 1)
      );
    })
  );

  for (const id of ids) {
    if (!messages.has(id)) {
      messages.set(id, []);
    }
  }

  const result: AgentRecord[] = [];
  const known = new Map<string, string>();
  let progress = true;

  while (progress) {
    progress = false;

    for (const [id, transcript] of messages) {
      if (known.has(id)) {
        continue;
      }

      const observed = object(runtime[id]);
      const saved = previous.get(`claude:${parent.sessionId ?? ""}:${id}`);
      const transcriptParent = transcript.find((message) => message.parent_agent_id)?.parent_agent_id;
      const ancestor = [transcriptParent, string(observed.parentId), saved?.claudeParent].find(Boolean);

      if (ancestor && !known.has(ancestor)) {
        continue;
      }

      const agentId = `claude:${parent.sessionId ?? ""}:${id}`;
      known.set(id, agentId);
      progress = true;
      const invocation = transcript.find((message) => message.parent_tool_use_id)?.parent_tool_use_id;
      const parentTurns = ancestor ? claudeTranscript(messages.get(ancestor) ?? []) : (parent.turns ?? []);
      // SDK subagent IDs and parent_agent_id establish ancestry, never prompt text.
      const tool = parentTurns.flatMap((turn) => turn.items).find((item) => item.nativeId === invocation);
      result.push({
        agent: {
          id: agentId,
          parentId: ancestor ? (known.get(ancestor) ?? parent.agent.id) : parent.agent.id,
          name: string(observed.name) || string(tool?.title) || `Agent ${id}`,
          source: "native",
          harness: "claude",
          status: "unknown",
          preview: "",
        },
        cwd: parent.cwd,
        sessionId: parent.sessionId,
        claudeRoot: parent.sessionId,
        claudeAgent: id,
        ancestryKnown: transcript.length > 0 || Object.hasOwn(runtime, id) || saved?.ancestryKnown,
        claudeParent: ancestor?.length ? ancestor : null,
      });
    }
  }

  return result;
}

export function observeClaudeChild(parent: AgentRecord, child: AgentRecord) {
  const runtime = object(object(parent.pocket ? JSON.parse(parent.pocket.metadata) : {}).nativeAgents);
  const status = agentStatusSchema.safeParse(object(runtime[child.claudeAgent ?? ""]).status);

  if (!(
    status.success &&
    ["running", "waiting", "completed", "failed", "closed"].includes(status.data) &&
    (!activeAgent({ ...child.agent, status: status.data }) || activeAgent(parent.agent))
  )) {
    return;
  }

  child.agent.status = status.data;
  child.observedStatus = status.data;
}
