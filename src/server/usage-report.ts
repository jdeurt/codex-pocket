import { type UsageRecord, type UsageSession, claudeUsage, codexUsage } from "./usage-records";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { object } from "../lib/protocol";
import path from "node:path";
import { readdir } from "node:fs/promises";

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
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory()
          ? sessionFiles(filename)
          : Promise.resolve(entry.isFile() && entry.name.endsWith(".jsonl") ? [filename] : []);
      })
    );
    return nested.flat().toSorted();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
Compare reported instants to an explicit half-open interval or an IANA local calendar day.
@param timestamp - Native event timestamp.
@param window - Validated caller-selected interval.
@returns Whether this event belongs to the requested report.
*/
function inWindow(timestamp: string, window: UsageWindow) {
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
Read native cumulative accounting from the beginning so interval boundaries do not count earlier work again.
@param filename - Saved native JSONL file.
@param harness - Provider format of this source root.
@param records - Deduplicated cross-file request records updated with the latest complete observation.
@returns Number of malformed lines whose usage could not be recovered.
*/
async function readUsage(filename: string, harness: "codex" | "claude", records: Map<string, UsageRecord>) {
  const lines = createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
  const session: UsageSession = { id: path.basename(filename), parentId: null, model: "unknown", cumulative: {} };
  let malformed = 0;

  for await (const line of lines) {
    try {
      const row = object(JSON.parse(line));
      const record = harness === "codex" ? codexUsage(row, session, filename) : claudeUsage(row, filename);
      if (record) {
        records.set(`${harness}:${record.id}`, record);
      }
    } catch {
      malformed++;
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
  return [...groups.values()].map((group) => ({
    ...group,
    sources: [...group.sources],
    status: "usage observed; session completion unknown",
    cost: {
      reportedUSD: group.reportedCostUSD,
      billedUSD: null,
      estimatedUSD: null,
      pricingSource: null,
      pricingDate: null,
      serviceTier: null,
    },
  }));
}

/**
Collect local saved usage from both harnesses, retaining provenance and missing coverage instead of inventing zero spend.
@param window - Explicit time interval or local calendar day.
@param roots - Native Codex and Claude session roots chosen by the caller.
@returns Repeatable JSON report suitable for both CLI export and further analysis.
*/
export async function usageReport(window: UsageWindow, roots: { codex: string; claude: string }) {
  const records = new Map<string, UsageRecord>();
  const sources = { codex: await sessionFiles(roots.codex), claude: await sessionFiles(roots.claude) };
  let malformedLines = 0;

  for (const harness of ["codex", "claude"] as const) {
    for (const filename of sources[harness]) {
      malformedLines += await readUsage(filename, harness, records);
    }
  }

  const selected = [...records.values()].filter((record) => inWindow(record.timestamp, window));
  const chats = groupedUsage(selected);

  return {
    window,
    unit: "tokens",
    generatedAt: new Date().toISOString(),
    chats,
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
