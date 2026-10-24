import { type RpcEvent, object, string } from "../lib/protocol";
import { codexActivity, codexParent } from "../lib/codex";
import type { AgentEntry } from "../lib/agents";

const OBSERVED_EVENTS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/completed",
  "thread/closed",
  "thread/archived",
  "thread/deleted",
]);
const CLOSED_EVENTS = new Set(["thread/closed", "thread/archived", "thread/deleted"]);

export type CodexAgentState = Record<string, Pick<AgentEntry, "parentId" | "name" | "status">>;

/** Project native descendant metadata without modifying previously published state.
@param entries - Previously scoped descendants.
@param event - Validated native event.
@param sessionId - Owning session identity.
@returns Independent metadata, or undefined when the event is unrelated.
*/
export function observedCodexAgents(
  entries: CodexAgentState,
  event: RpcEvent,
  sessionId: string | undefined
): CodexAgentState | undefined {
  if (!OBSERVED_EVENTS.has(event.method)) {
    return;
  }

  const thread = object(event.params.thread);
  const id = string(thread.id) || string(event.params.threadId);
  const parentId = codexParent(thread);
  const discovered =
    parentId && event.method === "thread/started" && (parentId === sessionId || Object.hasOwn(entries, parentId));
  const existing = Object.hasOwn(entries, id) ? entries[id] : undefined;
  const previous = discovered
    ? { parentId, name: string(thread.name) || string(thread.agentNickname), status: "unknown" as const }
    : existing;

  if (!previous) {
    return;
  }

  let status = previous.status;

  if (event.method === "thread/status/changed" || event.method === "thread/started") {
    status = codexActivity(object(event.params.status ?? thread.status));
  } else if (CLOSED_EVENTS.has(event.method)) {
    status = "closed";
  } else if (event.method === "turn/completed") {
    const nativeStatus = string(object(event.params.turn).status);

    status = nativeStatus === "completed" || nativeStatus === "failed" ? nativeStatus : "idle";
  }

  return { ...entries, [id]: { ...previous, status } };
}
