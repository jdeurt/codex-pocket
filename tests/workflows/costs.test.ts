import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { t } from "try";
import { pendingCost, decisionCost, piCost, voiceCost, codexCost, claudeCost } from "../../src/state/cost-observations";
import { costUSD } from "../../src/state/costs";
import { costChart } from "../../src/state/cost-chart";
import { observeCost, readCostReport } from "../../src/server/cost-store";
import { GET } from "../../src/app/api/costs/route";
import { costReportSchema } from "../../src/lib/costs";
import { classifyPredicates } from "../../src/tasks/classifier-client";
import { TASK_CLASSIFIERS } from "../../src/tasks/classifier-definitions";
import { piWorkflow } from "../fixtures/pi-workflow";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

const INSTANT = "2026-10-25T12:00:00.000Z";
const WINDOW = { start: "2026-10-24T00:00:00.000Z", end: "2026-10-27T00:00:00.000Z", timezone: "America/Los_Angeles" };
const SCOPE = {
  parentId: "synthetic-parent",
  feature: "task_intent" as const,
  provider: "openai",
  model: "gpt-6-luna",
};
const REQUEST_WINDOW_MS = 60_000;
const INPUT = 1000;
const CACHED = 200;
const WRITTEN = 100;
const OUTPUT = 50;
const EXPECTED_USD = 0.0000845;
const VOICE_SECONDS = 90;
const VOICE_USD = 0.075;
const PRIVATE_MODE = 0o600;
const MODE_MASK = 0o777;
const ORIGIN = "http://127.0.0.1:3000";

/** Match a deterministic feature without capturing test state.
@param group - Actual report contribution.
@returns Whether this is membership classification.
*/
function isMembership(group: { feature: string }) {
  return group.feature === "task_intent";
}

/** Match lifecycle coverage independently of table order.
@param group - Actual report contribution.
@returns Whether this is lifecycle classification.
*/
function isLifecycle(group: { feature: string }) {
  return group.feature === "task_lifecycle";
}

/** Select visible chart contributions.
@param bar - D3-computed rectangle.
@returns Whether recorded cost gives this rectangle a nonzero value.
*/
function isPricedBar(bar: { amount: number }) {
  return bar.amount > 0;
}

/** Restore the fixture's environment and remove its private ledger.
@param previous - Prior private-state directory override.
@param directory - Owned disposable directory.
*/
async function restoreCostEnvironment(previous: string | undefined, directory: string) {
  if (previous === undefined) {
    delete process.env.CODEX_POCKET_STATE_DIR;
  } else {
    process.env.CODEX_POCKET_STATE_DIR = previous;
  }

  const removed = await t(rm, directory, { recursive: true, force: true });

  if (!removed.ok) {
    throw removed.error;
  }
}

/** Select a report's recorded calendar date.
@param group - Daily contribution.
@returns Calendar date in the requested timezone.
*/
function recordedDay(group: { day: string }) {
  return group.day;
}

/**
Check exact subset accounting, independent voice billing and native source identities.
*/
function normalizedCosts() {
  const pending = pendingCost(SCOPE, "decision:one", INSTANT);
  const classified = decisionCost(
    pending,
    {
      usage: {
        input_tokens: INPUT,
        output_tokens: OUTPUT,
        input_tokens_details: { cached_tokens: CACHED, cache_write_tokens: WRITTEN },
      },
    },
    "complete"
  );

  assert.equal(classified.inputTokens, INPUT);
  assert.equal(classified.amountUSD, EXPECTED_USD);
  assert.equal(classified.costKind, "estimated");
  assert.equal(decisionCost(pending, {}, "aborted").amountUSD, null);
  assert.equal(decisionCost(pending, { usage: { input_tokens: -1 } }, "complete").amountUSD, null);
  assert.equal(costUSD(EXPECTED_USD), "$0.0000845");
  const voice = voiceCost({ ...pending, model: "gpt-live-1", feature: "voice" }, { usage: { seconds: VOICE_SECONDS } });

  assert.equal(voice.amountUSD, VOICE_USD);
  const pi = piCost("parent", {
    id: "native-entry",
    type: "message",
    timestamp: INSTANT,
    message: {
      role: "assistant",
      provider: "openai",
      model: "fixture-model",
      usage: {
        input: INPUT,
        cacheRead: CACHED,
        cacheWrite: WRITTEN,
        output: OUTPUT,
        cost: { total: EXPECTED_USD },
        totalTokens: INPUT + CACHED + WRITTEN + OUTPUT,
      },
    },
  });

  assert.equal(pi?.id, "pi:parent:native-entry");
  assert.equal(pi.inputTokens, INPUT + CACHED + WRITTEN);
  assert.equal(pi.costKind, "estimated");
  const summary = piCost(
    "parent",
    {
      id: "compact-entry",
      type: "compaction",
      timestamp: INSTANT,
      usage: {
        input: INPUT,
        cacheRead: CACHED,
        cacheWrite: WRITTEN,
        output: OUTPUT,
        totalTokens: INPUT + CACHED + WRITTEN + OUTPUT,
        cost: { total: EXPECTED_USD },
      },
    },
    { provider: "openai", model: "fixture-model" }
  );

  assert.equal(summary?.feature, "context");
  assert.equal(summary.amountUSD, EXPECTED_USD);
  const native = codexCost(
    "parent",
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "child",
        tokenUsage: {
          last: { inputTokens: INPUT, cachedInputTokens: CACHED, outputTokens: OUTPUT },
          total: { inputTokens: INPUT, outputTokens: OUTPUT },
        },
      },
    },
    "unknown-model",
    INSTANT
  );

  assert.equal(native?.amountUSD, null);
  assert.equal(native.inputTokens, INPUT);
  const claude = claudeCost(
    "parent",
    "child",
    {
      type: "assistant",
      message: {
        id: "claude-request",
        model: "unknown-model",
        usage: {
          input_tokens: INPUT,
          output_tokens: OUTPUT,
          cache_read_input_tokens: CACHED,
          cache_creation_input_tokens: WRITTEN,
        },
      },
    },
    INSTANT
  );

  assert.equal(claude?.inputTokens, INPUT + CACHED + WRITTEN);
  assert.equal(claude.amountUSD, null);
}

/** Observe native Pi source appends through the real runtime and verify restart deduplication.
@param context - Isolated native workflow and cleanup owner.
*/
async function nativePiCosts(context: TestContext) {
  const flow = await piWorkflow(context, 2);

  flow.provider.setResponses([fauxAssistantMessage("Synthetic response.")]);
  await flow.send("cost-request", "Explain the synthetic example.");
  const start = new Date(Date.now() - REQUEST_WINDOW_MS).toISOString();
  const end = new Date(Date.now() + REQUEST_WINDOW_MS).toISOString();
  const query = { start, end, timezone: "UTC", feature: "main" as const };
  const before = readCostReport(query);

  assert.equal(before.groups[0]?.calls, 1);
  await flow.main.close();
  const restored = flow.create();

  await restored.request("thread/resume", {});
  const after = readCostReport(query);

  assert.deepEqual(after.groups, before.groups);
}

/** Persist only synthetic accounting and ensure repeat observations replace rather than inflate totals.
@param context - Resource cleanup owner.
*/
async function durableCosts(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-costs-"));

  context.after(rm.bind(undefined, directory, { recursive: true, force: true }));
  const pending = pendingCost(SCOPE, "stable-attempt", INSTANT);

  observeCost(pending, directory);
  observeCost(decisionCost(pending, { usage: { input_tokens: INPUT } }, "complete"), directory);
  observeCost(decisionCost(pending, { usage: { input_tokens: INPUT } }, "complete"), directory);
  observeCost({ ...pending, id: "missing", status: "aborted", feature: "task_lifecycle" }, directory);
  const report = costReportSchema.parse(readCostReport(WINDOW, directory));
  const membership = report.groups.find(isMembership.bind(undefined));

  assert.equal(membership?.calls, 1);
  assert.equal(membership.inputTokens, INPUT);
  assert.equal(membership.unknownCosts, 0);
  assert.equal(report.groups.find(isLifecycle.bind(undefined))?.unknownCosts, 1);
  assert.equal(readCostReport({ ...WINDOW, feature: "task_intent" }, directory).groups.length, 1);
  assert.equal(readCostReport({ ...WINDOW, model: "unseen/model" }, directory).groups.length, 0);
  assert.equal(readCostReport({ ...WINDOW, end: INSTANT }, directory).groups.length, 0);
  assert.throws(readCostReport.bind(undefined, { ...WINDOW, end: WINDOW.start }, directory));
  assert.throws(readCostReport.bind(undefined, { ...WINDOW, timezone: "invalid/timezone" }, directory));
  const chart = costChart(report, "feature");

  assert.equal(chart.labels[0]?.day, "2026-10-23");
  assert.equal(chart.bars.filter(isPricedBar.bind(undefined)).length, 1);
  const file = await stat(path.join(directory, "costs.sqlite"));

  assert.equal(file.mode & MODE_MASK, PRIVATE_MODE);
  const contents = await readFile(path.join(directory, "costs.sqlite"), "utf8");

  assert.equal(contents.includes("amountUSD"), true);
  assert.equal(contents.includes("current_request"), false);
  observeCost({ ...pending, id: "nepal-before", feature: "voice", timestamp: "2026-10-25T18:10:00.000Z" }, directory);
  observeCost({ ...pending, id: "nepal-after", feature: "voice", timestamp: "2026-10-25T18:20:00.000Z" }, directory);
  const nepal = readCostReport({ ...WINDOW, feature: "voice", timezone: "Asia/Kathmandu" }, directory);

  assert.deepEqual(nepal.groups.map(recordedDay.bind(undefined)), ["2026-10-25", "2026-10-26"]);
  assert.equal(report.groups[0]?.reportedRecords, 0);
  observeCost(
    {
      ...pending,
      id: "reported-zero",
      feature: "voice",
      status: "complete",
      amountUSD: 0,
      costKind: "reported",
      pricingSource: "Synthetic provider receipt",
    },
    directory
  );
  const reported = readCostReport({ ...WINDOW, feature: "voice" }, directory);

  assert.equal(reported.groups[0]?.reportedRecords, 1);
  assert.equal(reported.groups[0]?.reportedUSD, 0);
}

/**
Replay a provider boundary with accounting and a deliberate failed retry.
*/
class DecisionProvider {
  fail = false;
  /** Return usage without receiving or retaining real credentials or user content.
  @returns Native HTTP response or simulated network failure.
  */
  fetch = () => {
    if (this.fail) {
      throw new Error("Synthetic transport failure");
    }

    return Promise.resolve(
      Response.json({
        answers: [{ type: "predicate", name: "work", probability: 1 }],
        usage: { input_tokens: INPUT, output_tokens: 0 },
      })
    );
  };
}

/** Exercise production transport recording and guarded HTTP filters through private persistence.
@param context - Resource and environment cleanup owner.
*/
async function classifiedCosts(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-classifier-costs-"));
  const previous = process.env.CODEX_POCKET_STATE_DIR;

  context.after(restoreCostEnvironment.bind(undefined, previous, directory));
  process.env.CODEX_POCKET_STATE_DIR = directory;
  const provider = new DecisionProvider();

  context.mock.method(globalThis, "fetch", provider.fetch);
  const questions = [{ type: "predicate" as const, name: "work", instructions: "Synthetic only" }];

  await classifyPredicates("synthetic-key", undefined, { text: "synthetic" }, questions, SCOPE);
  provider.fail = true;
  await assert.rejects(classifyPredicates("synthetic-key", undefined, {}, questions, SCOPE));
  const start = new Date(Date.now() - REQUEST_WINDOW_MS).toISOString();
  const end = new Date(Date.now() + REQUEST_WINDOW_MS).toISOString();
  const query = new URLSearchParams({ start, end, timezone: "America/Los_Angeles", feature: "task_intent" });
  const response = await GET(
    new Request(`${ORIGIN}/api/costs?${query.toString()}`, {
      headers: { Host: new URL(ORIGIN).host },
    })
  );

  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.ok, true);
  const report = costReportSchema.parse(await response.json());

  assert.equal(report.groups[0]?.calls, 2);
  assert.equal(report.groups[0]?.unknownCosts, 1);
  assert.equal(report.groups[0]?.failed, 1);
  assert.equal(report.groups[0]?.model, TASK_CLASSIFIERS.model);
  assert.equal(report.groups[0]?.inputTokens, INPUT);
  const foreign = await GET(
    new Request(`${ORIGIN}/api/costs?${query.toString()}`, {
      headers: { Host: "foreign.example" },
    })
  );

  assert.equal(foreign.ok, false);
}

await test("cost normalization counts cache subsets once and retains unknown native pricing", normalizedCosts);
await test("cost ledger survives reopen, deduplicates retries and filters time, feature and model", durableCosts);
await test("classifier transport records paid attempts and unknown failures behind guarded cost HTTP", classifiedCosts);
await test("Pi cost accounting observes actual source appends and deduplicates native restart imports", nativePiCosts);
