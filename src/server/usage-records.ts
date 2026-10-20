import { object, string } from "../lib/protocol";

export interface UsageRecord {
  id: string;
  sessionId: string;
  parentId: string | null;
  forkedFromId: string | null;
  harness: "codex" | "claude";
  model: string;
  timestamp: string;
  categories: Record<string, number>;
  source: string;
  reportedCostUSD: number | null;
}
export interface UsageSession {
  id: string;
  parentId: string | null;
  forkedFromId: string | null;
  model: string;
  cumulative: Record<string, number>;
}

/**
Retain every finite numeric provider usage category, including nested cache-duration categories.
@param value - Untrusted native usage object.
@param prefix - Nested category prefix, empty at the provider boundary.
@returns Numeric token categories with their original names intact.
*/
export function usageNumbers(value: unknown, prefix = ""): Record<string, number> {
  return Object.fromEntries(
    Object.entries(object(value)).flatMap(([key, entry]) => {
      const name = prefix ? `${prefix}.${key}` : key;

      if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) {
        return [[name, entry]];
      }

      return entry && typeof entry === "object" ? Object.entries(usageNumbers(entry, name)) : [];
    })
  );
}

/**
Apply Codex session/model metadata before collecting incremental accounting from cumulative native counters.
@param row - Parsed native rollout event.
@param session - Per-file native identity and prior cumulative accounting, including before the requested interval.
@param source - Original JSONL path retained as provenance.
@returns One incremental usage record, or undefined for metadata and duplicate counters.
*/
export function codexUsage(
  row: Record<string, unknown>,
  session: UsageSession,
  source: string
): UsageRecord | undefined {
  const payload = object(row.payload);
  const info = object(payload.info);
  const totals = usageNumbers(info.total_token_usage);
  const timestamp = string(row.timestamp);
  const nativeSource = object(payload.source);
  const subagent = object(nativeSource.subagent);

  const categories = Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [
      key,
      value >= (session.cumulative[key] ?? 0)
        ? value - (session.cumulative[key] ?? 0)
        : (usageNumbers(info.last_token_usage)[key] ?? value),
    ])
  );

  if (row.type === "session_meta") {
    session.id = string(payload.id) || session.id;
    session.forkedFromId = string(payload.forked_from_id) || null;
    session.parentId = string(payload.forked_from_id) || string(object(subagent.thread_spawn).parent_thread_id) || null;
  } else if (row.type === "turn_context") {
    session.model = string(payload.model) || session.model;
  }

  if (payload.type !== "token_count" || Object.keys(totals).length === 0) {
    return;
  }

  session.cumulative = totals;

  if (Object.values(categories).every((value) => value === 0)) {
    return;
  }

  return {
    id: `${session.id}:${timestamp}:${JSON.stringify(totals)}`,
    sessionId: session.id,
    parentId: session.parentId,
    forkedFromId: session.forkedFromId,
    harness: "codex",
    model: session.model,
    timestamp,
    categories,
    source,
    reportedCostUSD: null,
  };
}

/**
Normalize Claude's per-request usage, preserving its distinct cache read/write categories.
@param row - Parsed saved Claude conversation event.
@param source - Original JSONL path, including any native subagent directory.
@returns One replaceable request record, or undefined when usage is absent.
*/
export function claudeUsage(row: Record<string, unknown>, source: string): UsageRecord | undefined {
  const message = object(row.message);
  const categories = usageNumbers(message.usage);
  const parent = string(row.sessionId);
  const agent = string(row.agentId) || (/\/subagents\/agent-([^/]+)\.jsonl$/.exec(source)?.[1] ?? "");
  const sessionId = agent ? `${parent}:${agent}` : parent;
  const request = string(message.id) || string(row.requestId) || string(row.uuid);

  if (!sessionId || !request || Object.keys(categories).length === 0) {
    return;
  }

  return {
    id: `${sessionId}:${request}`,
    sessionId,
    parentId: agent ? parent : null,
    forkedFromId: null,
    harness: "claude",
    model: string(message.model) || "unknown",
    timestamp: string(row.timestamp),
    categories,
    source,
    reportedCostUSD: typeof row.costUSD === "number" ? row.costUSD : null,
  };
}
