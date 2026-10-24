import { usageReport } from "../../src/server/usage-report";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { t, ok, error } from "try";
import { redactLog } from "../../src/lib/log-redaction";
import { createRotatingLogStream } from "../../src/server/logging";
import { optionalFile } from "../../src/server/optional-file";
import { valueAfterCleanup } from "../../src/lib/results";
import { TextStream } from "../../src/server/text-stream";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import { initialSnapshot } from "../../src/lib/protocol";
import { keywordRetrieval, completedRetrieval, retrievalCapabilities } from "../../src/state/task-retrieval";

/**
Verify immutable nested diagnostics retain useful structure without secrets.
*/
function redactionBoundary() {
  const source = Object.freeze({
    token: "private",
    nested: Object.freeze({ type: "image", data: "abcdef", label: "keep" }),
  });

  assert.deepEqual(redactLog(source), {
    token: "[REDACTED]",
    nested: { type: "image", data: { imageBytesBase64Length: 6 }, label: "keep" },
  });
  assert.equal(source.token, "private");
  assert.equal(source.nested.data, "abcdef");
}

/** Read one retained native log file.
@param directory - Private test log directory.
@param name - Timestamped owned file.
@returns Written file text.
*/
function logText(directory: string, name: string) {
  return readFile(path.join(directory, name), "utf8");
}

/** Verify rotation keeps whole records, chronological retention and native completion.
@param context - Native cleanup owner.
*/
async function rotationBoundary(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-rotation-"));

  context.after(rm.bind(undefined, directory, { recursive: true, force: true }));
  const RECORD_BYTES = 4;
  const RETAINED_FILES = 2;
  const stream = createRotatingLogStream(directory, RECORD_BYTES, RETAINED_FILES);

  context.after(stream.destroy.bind(stream, undefined));
  stream.write("aaa\n");
  stream.write("bbb\n");
  stream.end("ccc\n");
  await finished(stream);
  const names = await readdir(directory);
  const values = await Promise.all(Array.from(names, logText.bind(undefined, directory)));

  assert.equal(values.length, RETAINED_FILES);
  assert.ok(values.includes("bbb\n"));
  assert.ok(values.includes("ccc\n"));
}

/** Supply an exact native-like failure for filesystem policy verification.
@param reason - Original failure object.
@returns Rejected operation.
*/
function failedRead(reason: Error): Promise<string> {
  return Promise.reject(reason);
}

/**
Verify optional filesystem reads preserve permission and arbitrary failures.
*/
async function filesystemBoundary() {
  const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });

  assert.equal(await optionalFile(failedRead, missing), null);
  const result = await t(optionalFile<string, [Error]>, failedRead, denied);

  assert.equal(result.ok, false);
  assert.equal(result.error, denied);
}

/**
Verify unconditional cleanup cannot replace the original operation failure.
*/
function cleanupBoundary() {
  const operation = new Error("operation");
  const cleanup = new Error("cleanup");
  const both = t(valueAfterCleanup, error(operation), error(cleanup));

  assert.ok(both.error instanceof AggregateError);
  assert.deepEqual(both.error.errors, [operation, cleanup]);
  assert.equal(t(valueAfterCleanup, error(operation), ok(undefined)).error, operation);
  assert.equal(t(valueAfterCleanup, ok("value"), error(cleanup)).error, cleanup);
  assert.equal(valueAfterCleanup(ok("value"), ok(undefined)), "value");
}

/** Track the owned producer's exact teardown count.
@param probe - Explicit test resource state.
*/
function disconnectProbe(probe: { stops: number }) {
  probe.stops++;
}

/** Connect the stream fixture without capturing its owner.
@param probe - Explicit test resource state.
@param stream - Native stream owner.
@returns Teardown for the exact connected producer.
*/
function connectProbe(probe: { stops: number }, stream: TextStream) {
  stream.send("ready\n");

  return disconnectProbe.bind(undefined, probe);
}

/**
Verify cancellation and repeated abort release the producer exactly once.
*/
async function metadataBoundary() {
  const controller = new AbortController();
  const probe = { stops: 0 };
  const stream = new ReadableStream(new TextStream(controller.signal, connectProbe.bind(undefined, probe)));
  const reader = stream.getReader();

  const first = await reader.read();

  assert.equal(new TextDecoder().decode(first.value), "ready\n");
  await reader.cancel();
  controller.abort();
  assert.equal(probe.stops, 1);
  const aborted = new AbortController();

  aborted.abort();
  const closed = new ReadableStream(new TextStream(aborted.signal, connectProbe.bind(undefined, probe)));

  const ending = await closed.getReader().read();

  assert.equal(ending.done, true);
  assert.equal(probe.stops, 1);
}

/**
Verify display projection can run repeatedly against frozen canonical input.
*/
function projectionBoundary() {
  const item = Object.freeze({
    id: "message",
    type: "userMessage",
    content: Object.freeze([{ type: "text", text: "hello" }]),
  });
  const state = structuredClone(initialSnapshot);

  // Protocol arrays remain mutable types; freezing at runtime exercises the actual boundary.
  state.turns = [{ id: "turn", status: "completed", items: [{ ...item, content: [...item.content] }] }];
  Object.freeze(state.turns[0].items[0]);
  Object.freeze(state.turns[0].items);
  Object.freeze(state.turns[0]);
  Object.freeze(state.turns);
  Object.freeze(state);
  assert.deepEqual(visibleSnapshot(state), visibleSnapshot(state));
  assert.equal(state.turns[0].items[0].type, "userMessage");
}

/**
Verify fallback evidence remains immutable and does not overwrite earlier capabilities.
*/
function capabilitiesBoundary() {
  const initial = retrievalCapabilities(true, true);

  Object.freeze(initial.reasons);
  Object.freeze(initial);
  const fallback = keywordRetrieval(initial, "model unavailable", true);

  assert.equal(initial.mode, "hybrid");
  assert.deepEqual(initial.reasons, []);
  assert.equal(fallback.mode, "keyword");
  assert.equal(fallback.reranked, false);
  assert.equal(completedRetrieval(initial, 0, false).reranked, false);
}

await test("immutable diagnostic redaction preserves the original input", redactionBoundary);
await test("native log rotation retains complete records and finishes", rotationBoundary);
await test("optional filesystem reads propagate permission failures", filesystemBoundary);
await test("operation and cleanup failures both reach the caller", cleanupBoundary);
await test("metadata stream cancellation releases its producer exactly once", metadataBoundary);
await test("visible projection accepts frozen canonical history", projectionBoundary);
await test("retrieval capabilities preserve the original state", capabilitiesBoundary);

/** Retain cumulative accounting across interval boundaries and malformed source records.
@param context - Native fixture cleanup owner.
*/
async function usageBoundary(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-usage-"));

  context.after(rm.bind(undefined, directory, { recursive: true, force: true }));
  const rows = [
    JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "fixture-model" } }),
    JSON.stringify({
      timestamp: "2026-01-02T00:00:00Z",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } },
      },
    }),
    '{"payload":',
    JSON.stringify({
      timestamp: "2026-01-02T00:02:00Z",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 150, cached_input_tokens: 60, output_tokens: 20 } },
      },
    }),
  ];

  await writeFile(path.join(directory, "session.jsonl"), rows.join("\n"));
  const report = await usageReport(
    { start: "2026-01-02T00:01:00Z", end: "2026-01-02T00:03:00Z", timezone: "UTC" },
    { codex: directory, claude: path.join(directory, "absent") }
  );

  assert.equal(report.coverage.malformedLines, 1);
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0].sessionId, "parent");
  assert.equal(report.records[0].model, "fixture-model");
  assert.deepEqual(report.records[0].categories, { input_tokens: 50, cached_input_tokens: 20, output_tokens: 10 });
  assert.equal(report.chats[0].estimate, null);
}

await test("native usage preserves prior counters across a malformed record and report boundary", usageBoundary);
