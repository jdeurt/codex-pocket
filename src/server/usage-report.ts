import { type UsagePrice, estimatedCost } from "./usage-cost";
import { type UsageRecord, type UsageSession, claudeUsage, codexUsage } from "./usage-records";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { object } from "../lib/protocol";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { t as attempt } from "try";

const HARNESSES = ["codex", "claude"] as const;

export interface UsageWindow {
  start?: string;
  end?: string;
  day?: string;
  timezone: string;
}

/**
Enumerate saved local JSONL records without traversing symlinks or assuming cloud coverage.
@param directory - Explicit native session root.
@returns Saved files under this root, or an empty list for a missing optional source.
*/
async function sessionFiles(directory: string): Promise<string[]> {
  const listed = await attempt(() => readdir(directory, { withFileTypes: true }));

  if (!listed.ok) {
    const error = listed.error;

    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const nested = await Promise.all(
    listed.value.map((entry) => {
      const filename = path.join(directory, entry.name);

      return entry.isDirectory()
        ? sessionFiles(filename)
        : Promise.resolve(entry.isFile() && entry.name.endsWith(".jsonl") ? [filename] : []);
    })
  );

  return nested.flat().toSorted((left, right) => left.localeCompare(right));
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

/**
Decode a saved record without treating normalization failures as malformed JSON.
@param line - One native JSONL line.
@returns Parsed native object or null for a truncated or malformed line.
*/
function parseUsageLine(line: string) {
  const outcome = attempt(object, JSON.parse(line));

  return outcome.ok ? outcome.value : null;
}

/**
Normalize one parsed record with the selected native harness adapter.
@param row - Decoded native object.
@param session - Rolling Codex metadata and counters.
@param filename - Original source file.
@param harness - Provider format owning the source.
@returns Incremental native usage when this row contains it.
*/
function normalizeUsage(
  row: Record<string, unknown>,
  session: UsageSession,
  filename: string,
  harness: "codex" | "claude"
) {
  return harness === "codex" ? codexUsage(row, session, filename) : claudeUsage(row, filename);
}

/**
Read native cumulative accounting from the beginning so interval boundaries do not count earlier work again.
@param filename - Saved native JSONL file.
@param harness - Provider format of this source root.
@param records - Deduplicated cross-file request records updated with the latest complete observation.
@returns Number of malformed lines whose usage could not be recovered.
*/
async function readUsage(filename: string, harness: "codex" | "claude", records: Map<string, UsageRecord>) {
  const lines = createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
  const session: UsageSession = {
    id: path.basename(filename),
    parentId: null,
    forkedFromId: null,
    model: "unknown",
    cumulative: {},
  };

  let malformed = 0;

  for await (const line of lines) {
    const row = parseUsageLine(line);
    const record = row === null ? undefined : normalizeUsage(row, session, filename, harness);

    if (row === null) {
      malformed++;
    }

    if (record) {
      records.set(`${harness}:${record.id}`, record);
    }
  }

  return malformed;
}

/**
Aggregate original categories by native chat and model without adding subset counters together.
@param records - In-window deduplicated native usage observations.
@returns Per-chat/model totals with parent relationships and explicit cost uncertainty.
*/
function groupedUsage(records: UsageRecord[]) {
  const groups = new Map<
    string,
    {
      sessionId: string;
      parentId: string | null;
      harness: string;
      model: string;
      categories: Record<string, number>;
      reportedCostUSD: number | null;
      records: number;
      sources: Set<string>;
    }
  >();

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

  return groups
    .values()
    .map((group) => ({
      ...group,
      sources: [...group.sources],
      status: "usage observed; session completion unknown",
      cost: {
        reportedUSD: group.reportedCostUSD,
        billedUSD: null,
        subscriptionUsage: null,
      },
    }))
    .toArray();
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
@returns Exportable usage report and honest coverage gaps.
*/
function assembleReport(
  window: UsageWindow,
  sources: { codex: string[]; claude: string[] },
  records: Map<string, UsageRecord>,
  malformedLines: number,
  prices: UsagePrice[]
) {
  const selected = records
    .values()
    .filter((record) => isInWindow(record.timestamp, window) && !isInheritedUsage(record, records))
    .toArray();
  const chats = groupedUsage(selected).map((chat) => ({
    ...chat,
    name: null,
    estimate: estimatedCost(
      selected.filter(
        (record) =>
          record.sessionId === chat.sessionId && record.model === chat.model && record.harness === chat.harness
      ),
      prices
    ),
  }));
  const totals = groupedUsage(
    selected.map((record) => ({
      ...record,
      sessionId: record.parentId ? "delegated" : "parent unknown",
      parentId: null,
    }))
  );

  return {
    window,
    unit: "tokens",
    generatedAt: new Date().toISOString(),
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

/**
Collect local saved usage from both harnesses, retaining provenance and missing coverage instead of inventing zero spend.
@param window - Explicit time interval or local calendar day.
@param roots - Native Codex and Claude session roots chosen by the caller.
@param prices - Explicit dated price records used for estimates only.
@returns Repeatable JSON report suitable for both CLI export and further analysis.
*/
export async function usageReport(
  window: UsageWindow,
  roots: { codex: string; claude: string },
  prices: UsagePrice[] = []
) {
  const records = new Map<string, UsageRecord>();
  const sources = { codex: await sessionFiles(roots.codex), claude: await sessionFiles(roots.claude) };

  let malformedLines = 0;

  for (const harness of HARNESSES) {
    const files = sources[harness];

    for (const filename of files) {
      malformedLines += await readUsage(filename, harness, records);
    }
  }

  return assembleReport(window, sources, records, malformedLines, prices);
}
