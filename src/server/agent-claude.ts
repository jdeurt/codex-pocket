import { type ClaudeMessage, claudeTranscript } from "./harness/transcript";
import { type Data, object, string } from "../lib/protocol";
import { agentStatusSchema, isActiveAgent } from "../lib/agents";
import { getSessionInfo, getSessionMessages, getSubagentMessages, listSubagents } from "@anthropic-ai/claude-agent-sdk";
import { type AgentRecord } from "./agent-sources";
import { agentRead } from "./agent-read-pool";

const LAST_MESSAGE = -1;

/**
Map Claude's native stop reason to the existing inactive catalog status.
@param messages - Native saved SDK messages in chronological order.
@returns Completed, idle or unknown status from the final native message.
*/
function claudeStopStatus(messages: ClaudeMessage[]): AgentRecord["agent"]["status"] {
  const last = object(messages.at(LAST_MESSAGE)?.message);

  if (["end_turn", "stop_sequence"].includes(string(last.stop_reason))) {
    return "completed";
  }

  return last.stop_reason === "max_tokens" ? "idle" : "unknown";
}

/**
Retain the latest saved model and apply native terminal status only to native descendants.
@param record - Scoped Claude record whose persisted Side Pocket status remains authoritative.
@param messages - Saved SDK messages already converted to canonical turns.
*/
function applyClaudeMetadata(record: AgentRecord, messages: ClaudeMessage[]) {
  const model = messages.map((message) => string(object(message.message).model)).findLast(Boolean);

  if (model) {
    record.agent.model = model;
  }

  if (record.pocket) {
    return;
  }

  record.agent.status = record.observedStatus ?? claudeStopStatus(messages);
}

/**
Read the native saved Claude session or subagent and project it into canonical turns.
@param record - Scoped Claude record receiving saved history and observed metadata.
@param sessionId - Native root session identity checked by the hydration owner.
*/
export async function readClaude(record: AgentRecord, sessionId: string) {
  const messages = record.claudeAgent
    ? await getSubagentMessages(record.claudeRoot ?? sessionId, record.claudeAgent, { dir: record.cwd })
    : await getSessionMessages(sessionId, { dir: record.cwd });

  if (record.pocket && messages.length === 0 && !(await getSessionInfo(sessionId, { dir: record.cwd }))) {
    throw new Error("Saved Claude history is unavailable.");
  }

  record.turns = claudeTranscript(messages);
  applyClaudeMetadata(record, messages);
}

/**
Normalize one SDK ancestry candidate using native IDs and saved ownership observations.
@param id - Native SDK subagent identity.
@param transcript - Native ancestry sample, never prompt-derived ancestry.
@param runtime - Parent-owned native lifecycle observations.
@param previous - Prior scoped records available for established ancestry reuse.
@param sessionId - Native root session owning this candidate.
@returns Candidate containing only the ancestry and display metadata needed for resolution.
*/
function claudeCandidate(
  id: string,
  transcript: ClaudeMessage[],
  runtime: Data,
  previous: Map<string, AgentRecord>,
  sessionId: string
) {
  const observed = object(runtime[id]);
  const saved = previous.get(`claude:${sessionId}:${id}`);
  const transcriptParent = transcript.find((message) => message.parent_agent_id)?.parent_agent_id;
  const ancestor = [transcriptParent, string(observed.parentId), saved?.claudeParent].find(Boolean);

  return { id, transcript, observed, saved, ancestor, isObserved: Object.hasOwn(runtime, id) };
}

type ClaudeCandidate = ReturnType<typeof claudeCandidate>;

/**
Append a resolved native Claude child after its ancestor is known.
@param parent - Scoped Claude root whose working directory and session are retained.
@param candidate - Normalized ancestry candidate whose ancestor has been resolved.
@param messages - Native ancestry samples indexed by subagent identity.
@param known - Resolved SDK-to-catalog identities receiving this child.
@param result - Ordered normalized descendants receiving the new record.
@param sessionId - Owning native root session identity.
*/
function appendClaudeCandidate(
  parent: AgentRecord,
  candidate: ClaudeCandidate,
  messages: Map<string, ClaudeMessage[]>,
  known: Map<string, string>,
  result: AgentRecord[],
  sessionId: string
) {
  const agentId = `claude:${sessionId}:${candidate.id}`;

  const invocation = candidate.transcript.find((message) => message.parent_tool_use_id)?.parent_tool_use_id;
  const parentTurns = candidate.ancestor
    ? claudeTranscript(messages.get(candidate.ancestor) ?? [])
    : (parent.turns ?? []);
  // SDK subagent IDs and parent_agent_id establish ancestry, never prompt text.
  const tool = parentTurns.flatMap((turn) => turn.items).find((item) => item.nativeId === invocation);

  known.set(candidate.id, agentId);
  result.push({
    agent: {
      id: agentId,
      parentId: candidate.ancestor ? (known.get(candidate.ancestor) ?? parent.agent.id) : parent.agent.id,
      name: string(candidate.observed.name) || string(tool?.title) || `Agent ${candidate.id}`,
      source: "native",
      harness: "claude",
      status: "unknown",
      preview: "",
    },
    cwd: parent.cwd,
    sessionId: parent.sessionId,
    claudeRoot: parent.sessionId,
    claudeAgent: candidate.id,
    ancestryKnown: candidate.transcript.length > 0 || candidate.isObserved || candidate.saved?.ancestryKnown,
    claudeParent: candidate.ancestor?.length ? candidate.ancestor : null,
  });
}

/**
Resolve native Claude descendants in ancestor order while retaining only verified SDK relationships.
@param parent - Scoped Claude root owning this discovery.
@param previous - Prior records available for established ancestry reuse.
@param runtime - Parent-owned native lifecycle observations.
@param messages - Native ancestry samples indexed by subagent identity.
@param sessionId - Owning native root session identity.
@returns Normalized native descendants whose ancestors can be resolved.
*/
function resolveClaudeAncestry(
  parent: AgentRecord,
  previous: Map<string, AgentRecord>,
  runtime: Data,
  messages: Map<string, ClaudeMessage[]>,
  sessionId: string
) {
  const result: AgentRecord[] = [];
  const known = new Map<string, string>();

  let isProgress = true;

  while (isProgress) {
    isProgress = false;

    for (const [id, transcript] of messages) {
      const candidate = claudeCandidate(id, transcript, runtime, previous, sessionId);

      if (known.has(id) || (candidate.ancestor && !known.has(candidate.ancestor))) {
        continue;
      }

      appendClaudeCandidate(parent, candidate, messages, known, result, sessionId);
      isProgress = true;
    }
  }

  return result;
}

/**
Read missing native ancestry samples through the shared pool before resolving the ownership tree.
@param parent - Scoped Claude root with a saved native session.
@param previous - Prior records whose established ancestry may be reused.
@param sessionId - Native root session already checked by the public discovery boundary.
@returns Normalized descendants based on SDK IDs and native observations.
*/
async function readClaudeChildren(
  parent: AgentRecord,
  previous: Map<string, AgentRecord>,
  sessionId: string
): Promise<AgentRecord[]> {
  const runtime = object(object(parent.pocket ? JSON.parse(parent.pocket.metadata) : {}).nativeAgents);
  const ids = [...new Set([...(await listSubagents(sessionId, { dir: parent.cwd })), ...Object.keys(runtime)])];
  const messages = new Map<string, ClaudeMessage[]>();

  await Promise.all(
    ids.map(async (id) => {
      const saved = previous.get(`claude:${sessionId}:${id}`);

      if (Object.hasOwn(runtime, id) || saved?.ancestryKnown) {
        return;
      }

      messages.set(id, await agentRead(() => getSubagentMessages(sessionId, id, { dir: parent.cwd, limit: 1 }), 1));
    })
  );

  for (const id of ids) {
    if (!messages.has(id)) {
      messages.set(id, []);
    }
  }

  return resolveClaudeAncestry(parent, previous, runtime, messages, sessionId);
}

/**
Discover saved Claude descendants only when their scoped root has a native session.
@param parent - Scoped Claude root whose SDK ancestry is being inspected.
@param previous - Previous records available for established ancestry reuse.
@returns Native descendant records, or an empty list for an unstarted root.
*/
export async function claudeChildren(
  parent: AgentRecord,
  previous = new Map<string, AgentRecord>()
): Promise<AgentRecord[]> {
  return parent.sessionId ? readClaudeChildren(parent, previous, parent.sessionId) : [];
}

/**
Apply parent-owned lifecycle observations without showing a child active under an inactive parent.
@param parent - Scoped Claude root whose native lifecycle metadata owns these observations.
@param child - Native descendant whose display status may be updated.
*/
export function observeClaudeChild(parent: AgentRecord, child: AgentRecord) {
  const runtime = object(object(parent.pocket ? JSON.parse(parent.pocket.metadata) : {}).nativeAgents);
  const status = agentStatusSchema.safeParse(object(runtime[child.claudeAgent ?? ""]).status);

  if (!(
    status.success &&
    ["running", "waiting", "completed", "failed", "closed"].includes(status.data) &&
    (!isActiveAgent({ ...child.agent, status: status.data }) || isActiveAgent(parent.agent))
  )) {
    return;
  }

  child.agent.status = status.data;
  child.observedStatus = status.data;
}
