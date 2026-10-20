import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { z } from "zod";

const exec = promisify(execFile);
const estimateSchema = z.object({ amount: z.number(), source: z.string(), currency: z.string() }).nullable();
const costSchema = z.object({ billedUSD: z.null(), reportedUSD: z.number().nullable() });
const chatSchema = z.object({
  sessionId: z.string(),
  parentId: z.string().nullable(),
  model: z.string(),
  categories: z.record(z.string(), z.number()),
  estimate: estimateSchema,
  cost: costSchema,
});
const reportSchema = z.object({
  chats: z.array(chatSchema),
  records: z.array(z.unknown()),
  coverage: z.object({ malformedLines: z.number() }),
});
const BEFORE = { input: 100, cached: 20, output: 10 };
const AFTER = { input: 150, cached: 30, output: 20 };
const CHILD = { input: 170, cached: 30, output: 24 };
const EXPECTED = {
  records: 3,
  input: 50,
  cached: 10,
  estimate: 0.000065,
  childInput: 20,
  cacheCreation: 13,
  reportedCost: 0.01,
};

/**
Create native cumulative token events whose reasoning and cache counters are subsets.
@param timestamp - Explicit accounting instant.
@param input - Cumulative native input.
@param cached - Cumulative cache-read subset.
@param output - Cumulative native output.
@returns Native Codex token-count event for the whole CLI fixture.
*/
function tokenEvent(timestamp: string, input: number, cached: number, output: number) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: output / 2,
          total_tokens: input + output,
        },
      },
    },
  };
}

/**
Write saved records covering interval boundaries, forks, repeated messages and missing lines.
@param directory - Private fixture root containing both provider directories.
*/
async function savedUsage(directory: string) {
  const codex = path.join(directory, "codex");
  const claude = path.join(directory, "claude");
  const events = [
    tokenEvent("2026-10-20T06:59:00Z", BEFORE.input, BEFORE.cached, BEFORE.output),
    tokenEvent("2026-10-20T08:00:00Z", AFTER.input, AFTER.cached, AFTER.output),
  ];
  const parent = [
    { type: "session_meta", payload: { id: "parent" } },
    { type: "turn_context", payload: { model: "priced-model" } },
    ...events,
  ];
  const child = [
    { type: "session_meta", payload: { id: "fork", forked_from_id: "parent" } },
    { type: "turn_context", payload: { model: "priced-model" } },
    ...events,
    tokenEvent("2026-10-20T09:00:00Z", CHILD.input, CHILD.cached, CHILD.output),
  ];
  const message = {
    sessionId: "claude-parent",
    agentId: "native-child",
    timestamp: "2026-10-20T10:00:00Z",
    costUSD: 0.01,
    message: {
      id: "request-one",
      model: "claude-fixture",
      usage: { input_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13, output_tokens: 5 },
    },
  };

  await mkdir(codex);
  await mkdir(claude);
  await writeFile(path.join(codex, "parent.jsonl"), parent.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(path.join(codex, "resumed-copy.jsonl"), parent.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(path.join(codex, "fork.jsonl"), child.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(
    path.join(claude, "child.jsonl"),
    [JSON.stringify(message), JSON.stringify(message), "partial invalid line"].join("\n")
  );
  await writeFile(
    path.join(directory, "prices.json"),
    JSON.stringify([
      {
        harness: "codex",
        model: "priced-model",
        currency: "USD",
        source: "fixture prices, not production pricing",
        date: "2026-10-20",
        serviceTier: null,
        perMillion: { uncached_input_tokens: 1, cached_input_tokens: 0.5, output_tokens: 2 },
      },
    ])
  );
}

/**
Run the actual callable usage procedure and validate local-day accounting and provenance.
@param directory - Private native fixtures and explicit dated test pricing.
*/
async function reportFlow(directory: string) {
  const args = [
    "--import",
    path.resolve("node_modules/tsx/dist/loader.mjs"),
    "scripts/usage.ts",
    "--day",
    "2026-10-20",
    "--timezone",
    "America/Los_Angeles",
    "--codex-dir",
    path.join(directory, "codex"),
    "--claude-dir",
    path.join(directory, "claude"),
    "--prices",
    path.join(directory, "prices.json"),
  ];
  const first = await exec(process.execPath, args);
  const second = await exec(process.execPath, args);
  const report = reportSchema.parse(JSON.parse(first.stdout));
  const repeated = reportSchema.parse(JSON.parse(second.stdout));
  const parent = report.chats.find((chat) => chat.sessionId === "parent");
  const fork = report.chats.find((chat) => chat.sessionId === "fork");
  const claude = report.chats.find((chat) => chat.sessionId === "claude-parent:native-child");

  assert.ok(parent);
  assert.ok(fork);
  assert.ok(claude);
  assert.deepEqual(report, repeated);
  assert.equal(report.records.length, EXPECTED.records);
  assert.equal(report.coverage.malformedLines, 1);
  assert.equal(parent.categories.input_tokens, EXPECTED.input);
  assert.equal(parent.categories.cached_input_tokens, EXPECTED.cached);
  assert.equal(parent.estimate?.amount, EXPECTED.estimate);
  assert.equal(fork.categories.input_tokens, EXPECTED.childInput);
  assert.equal(fork.parentId, "parent");
  assert.equal(claude.categories.cache_creation_input_tokens, EXPECTED.cacheCreation);
  assert.equal(claude.parentId, "claude-parent");
  assert.equal(claude.cost.reportedUSD, EXPECTED.reportedCost);
  assert.equal(claude.cost.billedUSD, null);
}

await test("usage CLI deduplicates native resumes, fork history and Claude requests with dated non-billed estimates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-usage-"));

  try {
    await savedUsage(directory);
    await reportFlow(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
