import type { UsagePrice } from "../state/usage-cost";
import { type UsageRecord, type UsageSession, claudeUsage, codexUsage } from "../state/usage-records";
import { type UsageWindow, assembleReport } from "../state/usage-report";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { object } from "../lib/protocol";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { t } from "try";

export type { UsageWindow } from "../state/usage-report";
const HARNESSES = ["codex", "claude"] as const;

/** Order discovered native paths deterministically.
@param left - First native path.
@param right - Second native path.
@returns Existing native path ordering.
*/
function comparePaths(left: string, right: string) {
  return left.localeCompare(right);
}

/** Enumerate original JSONL sources without following symlinks.
@param directory - Explicit source root.
@returns Sorted native sources, or an empty list for an absent root.
*/
async function sessionFiles(directory: string): Promise<string[]> {
  const listed = await t(readdir(directory, { withFileTypes: true }));

  if (!listed.ok) {
    const error = listed.error;

    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const pending: Promise<string[]>[] = [];
  const files: string[] = [];

  for (const entry of listed.value) {
    const filename = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      pending.push(sessionFiles(filename));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(filename);
    }
  }

  const nested = await Promise.all(pending);

  return [...files, ...nested.flat()].toSorted(comparePaths);
}

/** Read cumulative counters from the beginning of each original native file.
@param filename - Exact saved source file.
@param harness - Native provider format.
@returns Independent records and a count of malformed source lines.
*/
async function readUsage(filename: string, harness: "codex" | "claude") {
  const lines = createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
  const records: UsageRecord[] = [];

  let session: UsageSession = {
    id: path.basename(filename),
    parentId: null,
    forkedFromId: null,
    model: "unknown",
    cumulative: {},
  };
  let malformed = 0;

  for await (const line of lines) {
    const decoded = t(JSON.parse, line);

    if (!decoded.ok) {
      malformed++;
      continue;
    }

    const row = object(decoded.value);
    const normalized =
      harness === "codex" ? codexUsage(row, session, filename) : { session, record: claudeUsage(row, filename) };

    session = normalized.session;

    if (normalized.record) {
      records.push(normalized.record);
    }
  }

  return { records, malformed };
}

/** Collect local original usage and supply an explicit report generation timestamp.
@param window - Caller-selected interval or day.
@param roots - Explicit native source roots.
@param prices - Explicit dated prices, never inferred billing rates.
@returns Report preserving native provenance and coverage gaps.
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
      const read = await readUsage(filename, harness);

      malformedLines += read.malformed;

      for (const record of read.records) {
        records.set(`${harness}:${record.id}`, record);
      }
    }
  }

  return assembleReport(window, sources, records, malformedLines, prices, new Date().toISOString());
}
