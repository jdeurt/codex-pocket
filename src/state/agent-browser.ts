import { type AgentCatalog, type AgentEntry, isActiveAgent } from "../lib/agents";

export interface AgentVisit {
  data?: AgentCatalog;
  entries: Map<string, AgentEntry>;
}

/** Retain completed agents during a visit while refreshing current discovery results.
@param previous - Previously retained entries.
@param data - Latest readable catalog.
@param isOpen - Whether a visit remains active.
@returns Detached entries; retained active entries become unknown until rediscovered.
*/
export function retainedAgents(
  previous: ReadonlyMap<string, AgentEntry>,
  data: AgentCatalog | undefined,
  isOpen: boolean
) {
  const entries = new Map<string, AgentEntry>();

  if (isOpen) {
    for (const [id, agent] of previous) {
      entries.set(id, isActiveAgent(agent) ? { ...agent, status: "unknown" } : agent);
    }
  }

  const agents = data?.agents ?? [];

  for (const agent of agents) {
    entries.set(agent.id, agent);
  }

  return entries;
}

/** Order current work before completed work, then by display name.
@param first - First catalog entry.
@param second - Second catalog entry.
@returns Stable comparator result.
*/
export function compareAgents(first: AgentEntry, second: AgentEntry) {
  return Number(isActiveAgent(second)) - Number(isActiveAgent(first)) || first.name.localeCompare(second.name);
}
