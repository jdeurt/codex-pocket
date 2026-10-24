import { type UsagePrice, estimatedCost } from "./usage-cost";
import type { UsageRecord } from "./usage-records";

export interface UsageWindow {
  start?: string;
  end?: string;
  day?: string;
  timezone: string;
}

interface UsageGroup {
  sessionId: string;
  parentId: string | null;
  harness: string;
  model: string;
  categories: Record<string, number>;
  reportedCostUSD: number | null;
  records: number;
  sources: Set<string>;
}

/**
Compare reported instants to an explicit half-open interval or an IANA local calendar day.
@param timestamp - Native event timestamp.
@param window - Validated caller-selected interval.
@returns Whether this event belongs to the requested report.
*/
function isInWindow(timestamp: string, window: UsageWindow) {
  const time = Date.parse(timestamp);

  if (!Number.isFinite(time)) {
    return false;
  }

  if (window.day) {
    return (
      new Intl.DateTimeFormat("en-CA", {
        timeZone: window.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(time) === window.day
    );
  }

  return time >= Date.parse(window.start ?? "") && time < Date.parse(window.end ?? "");
}

/** Project a locally aggregated usage group into its export shape.
@param group - Native per-chat totals.
@returns Exportable totals with explicit billing uncertainty.
*/
function projectedGroup(group: UsageGroup) {
  return {
    ...group,
    sources: [...group.sources],
    status: "usage observed; session completion unknown",
    cost: { reportedUSD: group.reportedCostUSD, billedUSD: null, subscriptionUsage: null },
  };
}

/**
Aggregate original categories by native chat and model without adding subset counters together.
@param records - In-window deduplicated native usage observations.
@returns Per-chat/model totals with parent relationships and explicit cost uncertainty.
*/
function groupedUsage(records: UsageRecord[]) {
  const groups = new Map<string, UsageGroup>();

  for (const record of records) {
    const key = `${record.harness}:${record.sessionId}:${record.model}`;
    const group = groups.get(key) ?? {
      sessionId: record.sessionId,
      parentId: record.parentId,
      harness: record.harness,
      model: record.model,
      categories: {},
      reportedCostUSD: null,
      records: 0,
      sources: new Set<string>(),
    };

    for (const [category, value] of Object.entries(record.categories)) {
      group.categories[category] = (group.categories[category] ?? 0) + value;
    }

    if (record.reportedCostUSD !== null) {
      group.reportedCostUSD = (group.reportedCostUSD ?? 0) + record.reportedCostUSD;
    }

    group.records++;
    group.sources.add(record.source);
    groups.set(key, group);
  }

  return Array.from(groups.values(), projectedGroup);
}

/** Apply explicit dated pricing to one native chat and model.
@param records - Selected original usage records.
@param prices - Caller-supplied dated price records.
@param chat - Aggregated native chat/model totals.
@returns Chat totals with an explicit token-price estimate when available.
*/
function pricedChat(records: UsageRecord[], prices: UsagePrice[], chat: ReturnType<typeof projectedGroup>) {
  const matching: UsageRecord[] = [];

  for (const record of records) {
    if (record.sessionId === chat.sessionId && record.model === chat.model && record.harness === chat.harness) {
      matching.push(record);
    }
  }

  return { ...chat, name: null, estimate: estimatedCost(matching, prices) };
}

/** Group totals by recorded parent ownership without inventing missing ancestry.
@param record - Original native usage observation.
@returns Independent ownership category for aggregation.
*/
function ownershipCategory(record: UsageRecord) {
  return { ...record, sessionId: record.parentId ? "delegated" : "parent unknown", parentId: null };
}

/**
Recognize copied fork history using the ancestor's original event identity, leaving new child usage distinct.
@param record - Candidate native usage observation.
@param records - All collected native events, including those outside the report interval.
@returns Whether the exact inherited counter event is already attributed to its source chat.
*/
function isInheritedUsage(record: UsageRecord, records: Map<string, UsageRecord>) {
  const suffix = record.id.slice(record.sessionId.length);

  return record.forkedFromId !== null && records.has(`${record.harness}:${record.forkedFromId}${suffix}`);
}

/**
Build grouped report totals after collection, excluding inherited fork observations already attributed to an ancestor.
@param window - Requested interval.
@param sources - Inspected source file inventory.
@param records - Deduplicated native observations.
@param malformedLines - Count of unreadable JSON records.
@param prices - Explicit dated pricing sources.
@param generatedAt - Runtime-supplied report timestamp.
@returns Exportable usage report and honest coverage gaps.
*/
export function assembleReport(
  window: UsageWindow,
  sources: { codex: string[]; claude: string[] },
  records: Map<string, UsageRecord>,
  malformedLines: number,
  prices: UsagePrice[],
  generatedAt: string
) {
  const selected: UsageRecord[] = [];

  for (const record of records.values()) {
    if (isInWindow(record.timestamp, window) && !isInheritedUsage(record, records)) {
      selected.push(record);
    }
  }

  const chats = Array.from(groupedUsage(selected), pricedChat.bind(undefined, selected, prices));
  const totals = groupedUsage(Array.from(selected, ownershipCategory));

  return {
    window,
    unit: "tokens",
    generatedAt,
    chats,
    totals,
    coverage: {
      files: { codex: sources.codex.length, claude: sources.claude.length },
      malformedLines,
      cloud: "Only cloud usage present in locally saved/exported native records is included.",
      costs:
        "Provider-reported cost is retained when present. Billed charges, subscription consumption and token-price estimates are unavailable without billing/pricing records.",
      ancestry:
        "Native parent links are retained when recorded. Missing parent links remain null, not proof of main-chat ownership.",
      running:
        "A running session can emit additional usage after this report; incomplete or missing native records remain uncounted.",
    },
    subsets: {
      codex: {
        cached_input_tokens: "input_tokens",
        reasoning_output_tokens: "output_tokens",
        total_tokens: "input_tokens + output_tokens",
      },
      claude: {
        input_tokens: "uncached input; cache_read_input_tokens and cache_creation_input_tokens are additional input",
        "cache_creation.*": "cache_creation_input_tokens",
      },
    },
    records: selected,
  };
}
