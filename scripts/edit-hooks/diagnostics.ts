import { HookFailure, ROOT } from "./shared";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { ESLint } from "eslint";
import path from "node:path";
import { randomUUID } from "node:crypto";

const COUNTER_PATH = path.join(ROOT, "scripts/edit-hooks/diagnostics.json");

/** Validate the tracked counter before adding more occurrences.
@param value - Parsed JSON counter.
@returns Rule counts with safe nonnegative integer values.
*/
function parseCounter(value: unknown): Record<string, number> {
  const entries = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : null;

  if (!entries || entries.some(([, count]) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
    throw new HookFailure("diagnostics counter is invalid; existing counts were preserved");
  }

  return Object.fromEntries(entries);
}

/** Read the tracked counter without replacing malformed or unavailable data.
@returns Existing counts.
*/
async function readCounter(): Promise<Record<string, number>> {
  try {
    return parseCounter(JSON.parse(await readFile(COUNTER_PATH, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof HookFailure) {
      throw error;
    }

    throw new HookFailure("diagnostics counter could not be read; existing counts were preserved");
  }
}

/** Replace the tracked counter atomically while the after-edit runner lock is held.
@param counts - Complete validated rule counts.
*/
async function writeCounter(counts: Record<string, number>): Promise<void> {
  const temporary = `${COUNTER_PATH}.${randomUUID()}.tmp`;
  const sorted = Object.fromEntries(
    Object.keys(counts)
      .toSorted((left, right) => left.localeCompare(right, "en"))
      .map((rule) => [rule, counts[rule]])
  );

  try {
    await writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`);
    await rename(temporary, COUNTER_PATH);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Gather rule occurrences without deduplicating or truncating ESLint results.
@param results - Final post-auto-fix ESLint results.
@returns Occurrences by real rule ID.
*/
function countMessages(results: ESLint.LintResult[]): Map<string, number> {
  const increments = new Map<string, number>();

  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId) {
        increments.set(message.ruleId, (increments.get(message.ruleId) ?? 0) + 1);
      }
    }
  }

  return increments;
}

/** Count each remaining ESLint message with a rule ID once per completed edit cycle.
The caller holds the worktree runner lock. Parser and runner failures without rule IDs are omitted.
@param results - Final post-auto-fix ESLint results, before feedback truncation or deduplication.
*/
export async function recordDiagnostics(results: ESLint.LintResult[]): Promise<void> {
  const increments = countMessages(results);
  const counts = increments.size > 0 ? await readCounter() : null;

  if (!counts) {
    return;
  }

  for (const [rule, amount] of increments) {
    const total = (counts[rule] ?? 0) + amount;

    if (!Number.isSafeInteger(total)) {
      throw new HookFailure("diagnostics counter is full; existing counts were preserved");
    }

    counts[rule] = total;
  }

  try {
    await writeCounter(counts);
  } catch {
    throw new HookFailure("diagnostics counter could not be updated");
  }
}
