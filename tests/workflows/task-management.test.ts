import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { t as capture } from "try";
import { piWorkflow } from "../fixtures/pi-workflow";
import { workspace } from "../fixtures/workflow";
import { acceptTaskReceipts } from "../../src/tasks/ingestion";
import { TaskRepository } from "../../src/tasks/repository";
import { assignmentDecision, reconcileRoutes } from "../../src/tasks/reconciliation";
import { assignEvent, recordEvent, hasEventId } from "../../src/tasks/transitions";
import { recordTaskReport, inheritTaskCommand } from "../../src/tasks/command-provenance";
import { delegations } from "../../src/server/delegations";
import type { Ledger } from "../../src/tasks/model";

/** Select an accepted receipt from a persisted binding.
@param binding - Native binding.
@returns Receipt identity.
*/
function bindingReceiptId(binding: Ledger["bindings"][number]) {
  return binding.receiptId;
}

/** Identify an actual native tool result.
@param event - Recorded source event.
@returns Whether the source is a native tool result.
*/
function isToolResult(event: Ledger["events"][number]) {
  return event.origin === "tool_result";
}

/** Create an explicitly labeled deterministic assignment; this does not evaluate model quality.
@param repository - Actual private ledger owner.
@param receiptId - Accepted request identity.
@param taskId - Stable generated task identity.
@returns Committed assignment.
*/
function createTask(repository: TaskRepository, receiptId: string, taskId: string) {
  const state = repository.read();
  const decision = assignmentDecision(
    state,
    `request:${receiptId}`,
    { kind: "create", taskId, title: taskId },
    "classification",
    "synthetic-routing-fixture",
    "Synthetic intent decision for orchestration verification."
  );

  return repository.commit(reconcileRoutes(assignEvent(state, decision)), "Synthetic intent interpretation");
}

/** Select task IDs for a source event.
@param state - Actual durable checkpoint.
@param eventId - Source event identity.
@returns Assigned task identities.
*/
function memberTasks(state: Ledger, eventId: string) {
  const ids: string[] = [];

  for (const member of state.memberships) {
    if (member.eventId === eventId) {
      ids.push(member.taskId);
    }
  }

  return ids;
}

await test("task ledger connects late per-command reports after interleaved requests and rejects stale cross-parent commits", async (t) => {
  await workspace(t);
  acceptTaskReceipts(
    "parent",
    [
      { id: "epd", text: "Prepare a synthetic EPD leadership update.", status: "sent" },
      { id: "software", text: "Update Pocket software.", status: "unknown" },
      { id: "anthropic", text: "Fact-check the Anthropic announcement.", status: "sent" },
      { id: "projects", text: "Find the project list sent to Marc.", status: "sent" },
    ],
    {}
  );
  const repository = new TaskRepository("parent");

  t.after(repository.close.bind(repository));
  const original = repository.read();

  repository.commit(
    {
      ...original,
      commandIntents: [
        { key: "send:reused:first", callId: "call-first", requestId: "request:projects" },
        { key: "send:reused:second", callId: "call-second", requestId: "request:software" },
      ],
    },
    "Observed native delegate calls"
  );
  inheritTaskCommand("parent", "reused", "first-command", "send:reused:first");
  inheritTaskCommand("parent", "reused", "second-command", "send:reused:second");
  recordTaskReport("parent", "late-report", "first-command");
  recordTaskReport("parent", "update-report", "second-command");
  recordTaskReport("parent", "unknown-report", null);
  createTask(repository, "epd", "epd-task");
  createTask(repository, "software", "software-task");
  createTask(repository, "anthropic", "anthropic-task");
  createTask(repository, "projects", "projects-task");
  const routed = repository.read();

  assert.deepEqual(memberTasks(routed, "request:late-report"), ["projects-task"]);
  assert.deepEqual(memberTasks(routed, "request:update-report"), ["software-task"]);
  assert.deepEqual(memberTasks(routed, "request:unknown-report"), []);
  const DISTINCT_TASKS = 4;

  assert.equal(routed.tasks.length, DISTINCT_TASKS);
  assert.equal(routed.tasks[0].work, "open");
  assert.equal(routed.mode, "shadow");
  assert.equal(capture(repository.commit.bind(repository), original, "Stale proposal").ok, false);
  assert.equal(
    capture(recordEvent, routed, {
      id: "cross-parent",
      parentId: "other",
      origin: "typed",
      text: "Unrelated",
      contentRefs: [],
      visibility: "user",
      delivery: "not_delivered",
    }).ok,
    false
  );
  recordTaskReport("parent", "late-report", "first-command");
  assert.equal(repository.read().revision, routed.revision, "Retry must be idempotent");
  const other = new TaskRepository("other");

  t.after(other.close.bind(other));
  assert.deepEqual(other.read().events, []);
});

await test("Pi persists receipt-native bindings and call ownership across restart without reclassifying recovery or history", async (t) => {
  const flow = await piWorkflow(t, 2);
  const receipts = [
    { id: "request-one", text: "Write a project list.", status: "sent" as const },
    { id: "request-two", text: "Write a project list.", status: "unknown" as const },
    { id: "pocket-recovery:fixture", text: "Recover existing work.", status: "sent" as const },
    {
      id: "voice",
      text: "Historical EPD conversation and software work.",
      status: "sent" as const,
      source: { type: "realtime" as const, sessionId: "call", itemId: "backend", intent: "Find the project list." },
      voiceContext: { lastId: "old", text: "Historical Anthropic conversation." },
    },
  ];

  acceptTaskReceipts(flow.parent.id, receipts, {});
  flow.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "projects.txt", content: "Synthetic project list" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Project list saved."),
    fauxAssistantMessage("Received the second request."),
  ]);
  await flow.send("request-one", receipts[0].text);
  await flow.send("request-two", receipts[1].text);
  await flow.main.close();
  const repository = new TaskRepository(flow.parent.id);

  t.after(repository.close.bind(repository));
  const ingested = repository.read();

  assert.equal(ingested.bindings.length, 2);
  assert.deepEqual(new Set(Array.from(ingested.bindings, bindingReceiptId)), new Set(["request-one", "request-two"]));
  createTask(repository, "request-one", "project-task");
  const routed = repository.read();
  const toolResult = routed.events.find(isToolResult.bind(undefined));

  assert.ok(toolResult);
  assert.deepEqual(memberTasks(routed, toolResult.id), ["project-task"]);
  assert.equal(routed.events.find(hasEventId.bind(undefined, "request:voice"))?.text, "Find the project list.");
  assert.equal(routed.events.find(hasEventId.bind(undefined, "history:voice"))?.text, "");
  assert.deepEqual(memberTasks(routed, "request:pocket-recovery:fixture"), []);
  const resumed = flow.create();

  await resumed.request("thread/resume", {});
  await resumed.close();
  assert.deepEqual(repository.read(), routed, "Restart must not replay source ingestion or assignments");
});

/**
Close the process-owned store after the native MCP workflow.
*/
function closeDelegations() {
  globalThis.codexPocketDelegations?.close();
  Reflect.deleteProperty(globalThis, "codexPocketDelegations");
}

await test("native Pi delegate calls inherit request identity per command before semantic classification", async (t) => {
  const flow = await piWorkflow(t);
  const store = delegations();

  flow.cleanup(closeDelegations);
  store.saveParent(flow.parent.id, { cwd: flow.directory, policy: { sandbox: "read-only", approval: "never" } });
  acceptTaskReceipts(
    flow.parent.id,
    [
      { id: "project-request", text: "Find the project list.", status: "sent" },
      { id: "update-request", text: "Update software.", status: "sent" },
    ],
    {}
  );
  flow.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("mcp__pocket__side_pocket_create", {
        title: "Research",
        body: "Find the project list.",
        idempotencyKey: "project-command",
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Delegate queued."),
  ]);
  await flow.send("project-request", "Find the project list.");
  const child = store.list(flow.parent.id)[0];

  assert.ok(child, "The real MCP tool must create a managed delegate");
  flow.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("mcp__pocket__side_pocket_send", {
        id: child.id,
        message: "Update software.",
        idempotencyKey: "software-command",
        mode: "queue",
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Separate update queued."),
  ]);
  await flow.send("update-request", "Update software.");
  await flow.main.close();
  const repository = new TaskRepository(flow.parent.id);

  t.after(repository.close.bind(repository));
  const state = repository.read();

  assert.equal(state.commands.length, 2);
  assert.equal(state.commands[0].childId, state.commands[1].childId);
  assert.equal(state.commands[0].requestId, "request:project-request");
  assert.equal(state.commands[1].requestId, "request:update-request");
  assert.deepEqual(state.tasks, [], "Command provenance must not depend on semantic classification");
});
