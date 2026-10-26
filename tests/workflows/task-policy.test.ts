import test from "node:test";
import assert from "node:assert/strict";
import { t as capture } from "try";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { piWorkflow } from "../fixtures/pi-workflow";
import { workspace, eventually } from "../fixtures/workflow";
import { TaskClassifierReplay, classifierCredential } from "../fixtures/task-classifier";
import { z } from "zod";
import { nativeText } from "../../src/state/harness-transcript";
import { acceptTaskReceipts } from "../../src/tasks/ingestion";
import { changeTask, readTaskLedger } from "../../src/tasks/management";
import { migrateTaskLedger } from "../../src/tasks/migration";
import { taskReviewToken } from "../../src/tasks/review";
import { planTaskContext } from "../../src/tasks/context";
import { lifecycleInput } from "../../src/tasks/lifecycle-evidence";
import { TASK_RETENTION_POLICY } from "../../src/tasks/classifier-definitions";
import { latestDecision } from "../../src/tasks/reconciliation";

const toolStateSchema = z.object({ revision: z.number(), reviewToken: z.string(), applied: z.boolean().optional() });
const PREEMPTION_TIMEOUT_MS = 15_000;

/** Match only a native tool result.
@param message - Provider message.
@returns Tool-result role equality.
*/
function isToolResult(message: Context["messages"][number]) {
  return message.role === "toolResult";
}

/** Read one real native MCP result without hiding a tool failure.
@param context - Actual working-agent provider input.
@returns Decoded task result.
*/
function taskToolResult(context: Context) {
  const result = context.messages.findLast(isToolResult.bind(undefined));

  assert.ok(result?.role === "toolResult");
  assert.equal(result.isError, false, nativeText(result.content));

  return toolStateSchema.parse(JSON.parse(nativeText(result.content)));
}

/** Create the explicitly requested task association using a real inspected concurrency token.
@param context - Actual result of task inspection.
@returns Concrete native MCP repair invocation.
*/
function assignTask(context: Context) {
  const inspected = taskToolResult(context);

  return fauxAssistantMessage(
    fauxToolCall("mcp__pocket__pocket_task_change", {
      revision: inspected.revision,
      reviewToken: inspected.reviewToken,
      operation: {
        kind: "assign",
        eventId: "request:repair",
        assignment: {
          kind: "create",
          taskId: "repair-task",
          title: "Explicit current task",
        },
      },
      reason: "The current user explicitly requested this grouping.",
    }),
    { stopReason: "toolUse" }
  );
}

/** Archive the requested context using the new token returned by the preceding native tool.
@param context - Real committed assignment result.
@returns Concrete retention update, without an intermediate out-of-band mutation.
*/
function archiveTask(context: Context) {
  const applied = taskToolResult(context);

  assert.equal(applied.applied, true);

  return fauxAssistantMessage(
    fauxToolCall("mcp__pocket__pocket_task_change", {
      revision: applied.revision,
      reviewToken: applied.reviewToken,
      operation: { kind: "retain", taskId: "repair-task", retention: "archived" },
      reason: "The user requested this context be deferred.",
    }),
    { stopReason: "toolUse" }
  );
}

/** Verify the actual second mutation succeeded despite native source records arriving between calls.
@param context - Actual retention result.
@returns Final main-agent response.
*/
function repairedResponse(context: Context) {
  assert.equal(taskToolResult(context).applied, true);

  return fauxAssistantMessage("The requested grouping and archive change are recorded.");
}

await test("explicit task repairs survive their own native bookkeeping but reject intervening user input", async (t) => {
  const flow = await piWorkflow(t);
  const intent = "Group this current request, then archive its context.";

  acceptTaskReceipts(flow.parent.id, [{ id: "repair", text: intent, status: "sent" }], {});
  flow.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp__pocket__pocket_task_inspect", {}), { stopReason: "toolUse" }),
    assignTask,
    archiveTask,
    repairedResponse,
  ]);
  const completed = await flow.send("repair", intent);

  assert.equal(completed.status, "completed");
  const before = readTaskLedger(flow.parent.id);

  assert.equal(before.tasks[0].work, "open");
  assert.equal(before.tasks[0].retention, "archived");
  const token = taskReviewToken(before);

  acceptTaskReceipts(flow.parent.id, [{ id: "new", text: "Requirements changed.", status: "sent" }], {});
  const rejected = await capture(
    changeTask,
    flow.parent.id,
    before.revision,
    {
      kind: "retain",
      taskId: "repair-task",
      retention: "active",
    },
    "Apply stale review",
    token
  );

  assert.equal(rejected.ok, false);
  assert.equal(readTaskLedger(flow.parent.id).tasks[0].retention, "archived");
});

/** Observe classifier-maintained state for the real ordinary-question workflow.
@param parentId - Isolated parent.
@param work - Required work state.
@returns Whether the task reached that state.
*/
function hasWork(parentId: string, work: string) {
  return readTaskLedger(parentId).tasks[0]?.work === work;
}

await test("a delivered ordinary question is tracked and a later short answer updates the same task", async (t) => {
  const replay = new TaskClassifierReplay();
  const intent = "Ask which color, then write synthetic color notes.";
  const answer = "Blue, please.";

  replay.scenarios.set(intent, { outcome: "waiting", asksQuestion: true });
  replay.continuations.set(answer, { originalIntent: intent });
  t.mock.method(globalThis, "fetch", replay.fetch.bind(replay));
  const flow = await piWorkflow(t, 1, [], classifierCredential);

  acceptTaskReceipts(flow.parent.id, [{ id: "ask", text: intent, status: "sent" }], {});
  flow.provider.setResponses([fauxAssistantMessage("Which color should the notes use?")]);
  await flow.send("ask", intent);
  await eventually(hasWork.bind(undefined, flow.parent.id, "waiting"), "The delivered question must remain pending");
  assert.deepEqual(readTaskLedger(flow.parent.id).tasks[0].pendingQuestions, ["Which color should the notes use?"]);
  replay.scenarios.set(intent, { outcome: "resolved", areQuestionsAnswered: true });
  acceptTaskReceipts(flow.parent.id, [{ id: "answer", text: answer, status: "sent" }], {});
  flow.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "blue.txt", content: "Blue notes." }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Blue notes saved."),
  ]);
  await flow.send("answer", answer);
  await eventually(
    hasWork.bind(undefined, flow.parent.id, "resolved"),
    "The answer and verified result must finish work"
  );
  const state = readTaskLedger(flow.parent.id);

  assert.equal(state.tasks.length, 1);
  assert.deepEqual(state.tasks[0].pendingQuestions, []);
  const plan = planTaskContext(state, TASK_RETENTION_POLICY.contextBudget);

  assert.equal(plan.protectedContext.tasks[0].requestUpdates[0].text, answer);
});

await test("context and lifecycle assessment preserve later constraints and explicit multi-task spans", async (t) => {
  await workspace(t);
  await migrateTaskLedger("parent");
  const combined = "Alpha: use blue. Beta: use green.";

  acceptTaskReceipts(
    "parent",
    [
      { id: "alpha", text: "Prepare Alpha.", status: "sent" },
      { id: "beta", text: "Prepare Beta.", status: "sent" },
      { id: "both", text: combined, status: "sent" },
    ],
    {}
  );

  for (const id of ["alpha", "beta"]) {
    await changeTask(
      "parent",
      readTaskLedger("parent").revision,
      {
        kind: "assign",
        eventId: `request:${id}`,
        assignment: { kind: "create", taskId: id, title: id },
      },
      "Explicit synthetic task membership."
    );
  }

  const boundary = combined.indexOf("Beta");
  const state = await changeTask(
    "parent",
    readTaskLedger("parent").revision,
    {
      kind: "move",
      eventId: "request:both",
      taskIds: ["alpha", "beta"],
      spans: [
        { taskId: "alpha", start: 0, end: boundary },
        { taskId: "beta", start: boundary, end: combined.length },
      ],
    },
    "Reviewed independent constraints in one message."
  );
  const plan = planTaskContext(state, TASK_RETENTION_POLICY.contextBudget);

  assert.equal(plan.protectedContext.tasks[0].requestUpdates[0].text, "Alpha: use blue. ");
  assert.equal(plan.protectedContext.tasks[1].requestUpdates[0].text, "Beta: use green.");
  const input = lifecycleInput(state, state.tasks[0], [], [], false);

  assert.equal(input?.requests[1].text, "Alpha: use blue. ");
  const archived = await changeTask(
    "parent",
    state.revision,
    {
      kind: "retain",
      taskId: "alpha",
      retention: "archived",
    },
    "Explicitly defer this still-open task."
  );
  const deferred = planTaskContext(archived, TASK_RETENTION_POLICY.contextBudget);

  assert.equal(archived.tasks[0].work, "open");
  assert.equal(deferred.protectedContext.tasks.length, 1);
  assert.equal(deferred.protectedContext.deferred[0].id, "alpha");
});

await test(
  "new Pi input does not wait for a classifier that ignores cancellation",
  {
    timeout: PREEMPTION_TIMEOUT_MS,
  },
  async (t) => {
    const replay = new TaskClassifierReplay();
    const gate = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() };

    replay.gate = gate;
    t.mock.method(globalThis, "fetch", replay.fetch.bind(replay));
    const flow = await piWorkflow(t, 1, [], classifierCredential);

    flow.cleanup(gate.release.resolve.bind(undefined, undefined));
    acceptTaskReceipts(
      flow.parent.id,
      [{ id: "first", text: "Write synthetic background notes.", status: "sent" }],
      {}
    );
    flow.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "background.txt", content: "Synthetic notes." }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Notes saved."),
    ]);
    await flow.send("first", "Write synthetic background notes.");
    await gate.entered.promise;
    acceptTaskReceipts(flow.parent.id, [{ id: "second", text: "Accept this separate request.", status: "sent" }], {});
    flow.provider.setResponses([fauxAssistantMessage("The new request was received.")]);
    const completed = await flow.send("second", "Accept this separate request.");

    assert.equal(completed.status, "completed", "Main work must not wait for classifier cleanup");
    replay.gate = undefined;
    gate.release.resolve(undefined);
    await eventually(hasWork.bind(undefined, flow.parent.id, "resolved"), "Fresh review must recover after preemption");
  }
);

/** Observe the actual classified conversational root.
@param parentId - Isolated parent.
@returns Whether the greeting has an explicit conversational assignment.
*/
function hasGreetingDecision(parentId: string) {
  return latestDecision(readTaskLedger(parentId), "request:greeting")?.assignment.kind === "conversation";
}

await test("greeting bindings and their native replies remain conversational without pending task aliases", async (t) => {
  const replay = new TaskClassifierReplay();

  replay.conversations.add("Hello!");
  t.mock.method(globalThis, "fetch", replay.fetch.bind(replay));
  const flow = await piWorkflow(t, 1, [], classifierCredential);

  acceptTaskReceipts(flow.parent.id, [{ id: "greeting", text: "Hello!", status: "sent" }], {});
  flow.provider.setResponses([fauxAssistantMessage("Hello!")]);
  await flow.send("greeting", "Hello!");
  await eventually(hasGreetingDecision.bind(undefined, flow.parent.id), "Greeting interpretation must complete");
  const state = readTaskLedger(flow.parent.id);
  const plan = planTaskContext(state, TASK_RETENTION_POLICY.contextBudget);

  assert.deepEqual(state.tasks, []);
  assert.deepEqual(plan.protectedContext.unresolved, []);

  for (const event of state.events) {
    assert.equal(latestDecision(state, event.id)?.assignment.kind, "conversation", JSON.stringify(event));
  }
});
