import { type AgentEntry, isActiveAgent } from "../lib/agents";
import type { AgentRecord } from "../server/agent-sources";
import type { discoverAgents } from "../server/agent-catalog";

type Discovery = Awaited<ReturnType<typeof discoverAgents>>;

/** Retain a source outage without inventing active work.
@param previous - Verified previous source record.
@returns Unavailable record retaining readable history.
*/
function unavailableAgent(previous: AgentRecord): AgentRecord {
  return {
    ...previous,
    agent: { ...previous.agent, status: isActiveAgent(previous.agent) ? "unknown" : previous.agent.status },
    historyError: true,
    discoveryError: true,
  };
}

/** Sort active work before other catalog entries.
@param a - First entry.
@param b - Second entry.
@returns Stable active-first, alphabetical ordering.
*/
export function compareCatalogAgents(a: AgentEntry, b: AgentEntry) {
  return Number(isActiveAgent(b)) - Number(isActiveAgent(a)) || a.name.localeCompare(b.name);
}

/** Select a catalog entry from a record.
@param record - Scoped native source.
@returns User-visible entry.
*/
export function catalogAgent(record: AgentRecord) {
  return record.agent;
}

/** Retain only same-owner history through native source outages.
@param next - Fresh verified discovery.
@param saved - Previous scoped discovery.
@returns Independent merged records and catalog.
*/
export function preserveHistory(next: Discovery, saved?: Discovery): Discovery {
  if (saved?.owner !== next.owner) {
    return next;
  }

  const records = new Map(next.records);

  for (const [id, record] of records) {
    const previous = saved.records.get(id);

    if (record.historyError && previous?.turns) {
      records.set(id, {
        ...record,
        turns: previous.turns,
        agent: { ...record.agent, preview: previous.agent.preview },
      });
    }
  }

  for (const [id, previous] of saved.records) {
    const source = previous.agent.harness === "codex" ? "Codex" : "Claude Code";

    let isUnavailable = false;

    for (const warning of next.catalog.warnings) {
      isUnavailable ||= warning.startsWith(source);
    }

    if (isUnavailable && !records.has(id) && previous.agent.source === "native") {
      records.set(id, unavailableAgent(previous));
    }
  }

  return {
    ...next,
    records,
    catalog: { ...next.catalog, agents: Array.from(records.values(), catalogAgent).toSorted(compareCatalogAgents) },
  };
}
