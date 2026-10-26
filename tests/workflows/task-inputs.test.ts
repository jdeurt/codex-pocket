import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { piWorkflow } from "../fixtures/pi-workflow";
import { toolJson } from "../fixtures/tool-json";
import { object } from "../../src/lib/protocol";
import { readTaskLedger, changeTask } from "../../src/tasks/management";
import { migrateTaskLedger } from "../../src/tasks/migration";
import { planTaskContext } from "../../src/tasks/context";
import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { workspace } from "../fixtures/workflow";
import { preservePiOrigins } from "../../src/tasks/adapters/pi";
import { acceptTaskReceipts } from "../../src/tasks/ingestion";
import { ingestNativeTaskEvent } from "../../src/tasks/native-ingestion";
import { saveTaskSource, taskDirectory } from "../../src/tasks/archive";
import { nativeText } from "../../src/state/harness-transcript";
import { TaskRepository } from "../../src/tasks/repository";
import { classifiedCheckpoint } from "../../src/tasks/classification-runtime";
import { hasEventId } from "../../src/tasks/transitions";

await test("identical native inputs with the same timestamp retain distinct receipt bindings after native restart", async (t) => {
  const scope = await workspace(t);
  const manager = SessionManager.create(scope.directory, path.join(scope.directory, "sessions"));
  const input = { role: "user" as const, content: "Keep the exact project list.", timestamp: 0 };

  preservePiOrigins(manager, "first", input, "run");
  manager.appendMessage(input);
  preservePiOrigins(manager, "second", { ...input }, "run");
  manager.appendMessage({ ...input });
  const answer = fauxAssistantMessage("The project list is retained.");

  preservePiOrigins(manager, undefined, answer, "run");
  const answerId = manager.appendMessage(answer);
  const filename = manager.getSessionFile();

  assert.ok(filename);
  const resumed = SessionManager.open(filename);
  const entries = resumed.getEntries();

  acceptTaskReceipts(
    "parent",
    [
      { id: "first", text: input.content, status: "sent" },
      { id: "second", text: input.content, status: "unknown" },
    ],
    {}
  );
  const repository = new TaskRepository("parent");

  scope.cleanup(repository.close.bind(repository));
  let state = repository.read();

  for (const entry of entries) {
    const sequence = state.nextSequence;

    let file = "";

    if (entry.type === "message") {
      await saveTaskSource("parent", {
        id: entry.id,
        sequence,
        role: entry.message.role,
        text: nativeText("content" in entry.message ? entry.message.content : ""),
        original: entry,
      });
      file = path.join(taskDirectory("parent"), "source", `${String(sequence)}.json`);
    }

    state = ingestNativeTaskEvent("parent", entries, entry, file, sequence);
  }

  assert.equal(state.bindings.length, 2);
  assert.equal(state.bindings[0].receiptId, "first");
  assert.equal(state.bindings[1].receiptId, "second");
  assert.notEqual(state.bindings[0].nativeEntryId, state.bindings[1].nativeEntryId);
  const first = state.events.find(hasEventId.bind(undefined, "request:first"));

  assert.ok(first);
  state = repository.commit(
    classifiedCheckpoint(
      state,
      first,
      { actionable: 1, independent: 1, cancel: 0, correction: 0, matches: [] },
      "project-task"
    ),
    "Canned original intent."
  );
  const second = state.events.find(hasEventId.bind(undefined, "request:second"));

  assert.ok(second);
  state = repository.commit(
    classifiedCheckpoint(
      state,
      second,
      {
        actionable: 1,
        independent: 0,
        cancel: 0,
        correction: 0,
        matches: [{ taskId: "project-task", probability: 1 }],
      },
      "unused"
    ),
    "Canned same-task correction."
  );
  const response = state.events.find(hasEventId.bind(undefined, `native:${answerId}`));

  assert.ok(response);
  assert.deepEqual(response.requestIds, ["request:first", "request:second"]);
  let hasResponseMembership = false;

  for (const member of state.memberships) {
    hasResponseMembership ||= member.eventId === response.id && member.taskId === "project-task";
  }

  assert.equal(hasResponseMembership, true, "Consistent explicit request origins establish task membership");
});

const CONTEXT_BUDGET = 24_000;
const LARGE_INTENT_LENGTH = 32_000;

/** Verify the real provider boundary receives navigation when protected work exceeds its budget.
@param context - Actual SDK provider input after application context selection.
@returns Synthetic main-agent completion without paid inference.
*/
function boundedContextResponse(context: Context) {
  let packet = "";

  for (const message of context.messages) {
    if (message.role !== "system") {
      continue;
    }

    const text = nativeText(message.content);

    if (text.includes('"source":"task_ledger_context"')) {
      packet = text;
    }
  }

  assert.match(packet, /compactionAllowed/);
  assert.ok(packet.length < CONTEXT_BUDGET, "Oversized original intent must not be duplicated into provider input");

  return fauxAssistantMessage("The retained task context can be inspected.");
}

await test("oversized protected work stays exact while native model input uses bounded inspection navigation", async (t) => {
  const flow = await piWorkflow(t);

  acceptTaskReceipts(
    flow.parent.id,
    [
      { id: "old", text: "Review the long report.", status: "sent" },
      { id: "current", text: "Continue with the current request.", status: "sent" },
    ],
    {}
  );
  const before = readTaskLedger(flow.parent.id);
  const originalIntent = "x".repeat(LARGE_INTENT_LENGTH);
  const state = await changeTask(
    flow.parent.id,
    before.revision,
    {
      kind: "assign",
      eventId: "request:old",
      assignment: {
        kind: "create",
        taskId: "long-report",
        title: "Long report",
        originalIntent,
      },
    },
    "Explicit original context retained for this workflow."
  );
  const plan = planTaskContext(state, CONTEXT_BUDGET);

  assert.equal(plan.canCompact, false);
  assert.ok(plan.text.includes(originalIntent));
  assert.ok(plan.modelText.length <= CONTEXT_BUDGET);
  flow.provider.setResponses([boundedContextResponse]);
  await flow.send("current", "Continue with the current request.");
  await flow.main.close();
  assert.equal(readTaskLedger(flow.parent.id).tasks[0].originalIntent, originalIntent);
});

await test("task inspection pages and selected evidence remain parent-scoped through the native MCP boundary", async (t) => {
  const scope = await workspace(t);

  await migrateTaskLedger("parent");
  acceptTaskReceipts(
    "parent",
    [
      { id: "one", text: "Alpha request", status: "sent" },
      { id: "two", text: "Beta request", status: "sent" },
    ],
    {}
  );

  for (const [id, title] of [
    ["one", "Alpha"],
    ["two", "Beta"],
  ]) {
    await changeTask(
      "parent",
      readTaskLedger("parent").revision,
      { kind: "assign", eventId: `request:${id}`, assignment: { kind: "create", taskId: id, title } },
      "Explicit fixture assignment."
    );
  }

  const client = new Client({ name: "task-inspection-workflow", version: "1" });

  scope.cleanup(client.close.bind(client));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "scripts/mcp.ts"],
      cwd: process.cwd(),
      env: { CODEX_POCKET_STATE_DIR: scope.directory, POCKET_THREAD_ID: "parent" },
      stderr: "pipe",
    })
  );
  const result = await client.callTool({ name: "pocket_task_inspect", arguments: { limit: 1 } });
  const page = object(toolJson(result));

  assert.ok(Array.isArray(page.tasks));
  assert.equal(page.tasks.length, 1);
  assert.equal(object(page.totals).tasks, 2);
  const selected = await client.callTool({ name: "pocket_task_inspect", arguments: { eventId: "request:one" } });

  const detail = object(toolJson(selected));

  assert.equal(object(detail.event).text, "Alpha request");
  const forged = await client.callTool({ name: "pocket_task_inspect", arguments: { owner: "other-parent" } });

  assert.equal(forged.isError, true);
});
