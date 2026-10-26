import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall, getSystemMessageText, type Context } from "@earendil-works/pi-ai";
import { piWorkflow } from "../fixtures/pi-workflow";
import { eventually, workspace } from "../fixtures/workflow";
import { TaskClassifierReplay, classifierCredential } from "../fixtures/task-classifier";
import { acceptTaskReceipts } from "../../src/tasks/ingestion";
import { readTaskLedger, changeTask } from "../../src/tasks/management";
import { migrateTaskLedger } from "../../src/tasks/migration";
import { planTaskContext, taskDelivery } from "../../src/tasks/context";
import { reviewTaskLifecycle } from "../../src/tasks/lifecycle-runtime";
import { recordEvent, assignEvent } from "../../src/tasks/transitions";
import { updateTasks } from "../../src/tasks/repository";
import { assignmentDecision } from "../../src/tasks/reconciliation";
import { TASK_CLASSIFIERS, TASK_RETENTION_POLICY } from "../../src/tasks/classifier-definitions";
import type { Ledger } from "../../src/tasks/model";
import { t as capture } from "try";

const LAST = -1;
const TASK_COUNT = 3;

/** Find a task by the exact synthetic original request.
@param parentId - Isolated parent.
@param intent - Original request text.
@returns Stored task when interpretation has completed.
*/
function taskFor(parentId: string, intent: string) {
  for (const task of readTaskLedger(parentId).tasks) {
    if (task.originalIntent === intent) {
      return task;
    }
  }
}

/** Observe an actual persisted work state.
@param parentId - Isolated parent.
@param intent - Original request.
@param work - Required state.
@returns Whether background lifecycle assessment reached that state.
*/
function hasWork(parentId: string, intent: string, work: string) {
  return taskFor(parentId, intent)?.work === work;
}

/** Await automatic resolution and retain meaningful source/review diagnostics on failure.
@param parentId - Isolated parent.
@param intent - Current request.
@param replay - Observed external classifier calls.
*/
async function waitForResolution(parentId: string, intent: string, replay: TaskClassifierReplay) {
  const waited = await capture(
    eventually,
    hasWork.bind(undefined, parentId, intent, "resolved"),
    "Automatic resolution"
  );

  if (waited.ok) {
    return;
  }

  const state = readTaskLedger(parentId);

  throw new Error(JSON.stringify({ tasks: state.tasks, reviews: state.lifecycleReviews, requests: replay.requests }), {
    cause: waited.error,
  });
}

/** Observe an assessment without asserting that the model's unsupported claim was accepted.
@param parentId - Isolated parent.
@param intent - Original request.
@returns Whether a dedicated lifecycle review was persisted.
*/
function hasAssessment(parentId: string, intent: string) {
  const task = taskFor(parentId, intent);

  for (const review of readTaskLedger(parentId).lifecycleReviews) {
    if (review.taskId === task?.id) {
      return true;
    }
  }

  return false;
}

/** Read system text at the actual provider boundary.
@param message - Native provider input message.
@returns System text or an empty string for another role.
*/
function systemText(message: Context["messages"][number]) {
  return message.role === "system" ? getSystemMessageText(message) : "";
}

/** Execute file work while asserting the main prompt delegates bookkeeping to the task subsystem.
@param filename - Synthetic output file.
@param context - Actual working-agent provider input.
@returns Native write invocation; no task-management operation is scripted.
*/
function writeResponse(filename: string, context: Context) {
  const prompt = Array.from(context.messages, systemText).join("\n");

  assert.match(prompt, /The task subsystem owns task membership and lifecycle assessment/u);

  return fauxAssistantMessage(fauxToolCall("write", { path: filename, content: "Verified synthetic notes.\n" }), {
    stopReason: "toolUse",
  });
}

/** Match only a real canonical phone question.
@param event - Actual native event.
@returns Whether an answer is pending.
*/
function isQuestion(event: { id?: string | number }) {
  return event.id !== undefined;
}

await test("dedicated classification completes verified Pi work and archives old terminal context without agent bookkeeping", async (t) => {
  const replay = new TaskClassifierReplay();

  t.mock.method(globalThis, "fetch", replay.fetch.bind(replay));
  const flow = await piWorkflow(t, 1, [], classifierCredential);

  for (let index = 0; index < TASK_COUNT; index++) {
    const intent = `Write and verify synthetic notes ${String(index)}.`;
    const filename = `notes-${String(index)}.txt`;
    const id = `request-${String(index)}`;

    acceptTaskReceipts(flow.parent.id, [{ id, text: intent, status: "sent" }], {});
    flow.provider.setResponses([
      writeResponse.bind(undefined, filename),
      fauxAssistantMessage(fauxToolCall("read", { path: filename }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The verified notes are saved."),
    ]);
    const completed = await flow.send(id, intent);

    assert.equal(completed.status, "completed");
    await waitForResolution(flow.parent.id, intent, replay);
    assert.equal(await readFile(path.join(flow.directory, filename), "utf8"), "Verified synthetic notes.\n");
  }

  const state = readTaskLedger(flow.parent.id);

  assert.equal(state.tasks.length, TASK_COUNT);
  assert.equal(state.tasks[0].retention, "archived");
  assert.equal(state.tasks[0].work, "resolved");
  assert.equal(state.tasks[1].retention, "active");
  const plan = planTaskContext(state, TASK_RETENTION_POLICY.contextBudget);

  assert.equal(plan.protectedContext.tasks.length, 2);
  assert.equal(state.lifecycleReviews.at(LAST)?.version, TASK_CLASSIFIERS.lifecycle.version);
  assert.ok(state.lifecycleReviews.at(LAST)?.evidence.length);
});

await test("a positive classifier cannot resolve Pi work from a done claim or a failed tool", async (t) => {
  const replay = new TaskClassifierReplay();

  t.mock.method(globalThis, "fetch", replay.fetch.bind(replay));
  const flow = await piWorkflow(t, 1, [], classifierCredential);
  const intent = "Write the missing synthetic file.";

  acceptTaskReceipts(flow.parent.id, [{ id: "claim", text: intent, status: "sent" }], {});
  flow.provider.setResponses([fauxAssistantMessage("Done!")]);
  await flow.send("claim", intent);
  await eventually(hasAssessment.bind(undefined, flow.parent.id, intent), "The unsupported claim must be assessed");
  assert.equal(taskFor(flow.parent.id, intent)?.work, "open");
  assert.equal(
    taskDelivery(readTaskLedger(flow.parent.id), readTaskLedger(flow.parent.id).tasks[0]).state,
    "delivered"
  );
  const failedIntent = "Read the absent synthetic report.";

  acceptTaskReceipts(flow.parent.id, [{ id: "failed", text: failedIntent, status: "sent" }], {});
  flow.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "absent-report.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done!"),
  ]);
  await flow.send("failed", failedIntent);
  await eventually(
    hasAssessment.bind(undefined, flow.parent.id, failedIntent),
    "The failed operation must be assessed"
  );
  assert.equal(taskFor(flow.parent.id, failedIntent)?.work, "open");
});

await test("native questions become waiting and answers clear pending state before verified completion", async (t) => {
  const replay = new TaskClassifierReplay();

  t.mock.method(globalThis, "fetch", replay.fetch.bind(replay));
  const flow = await piWorkflow(t, 1, [], classifierCredential);
  const intent = "Write synthetic color notes after asking which color.";

  acceptTaskReceipts(flow.parent.id, [{ id: "color", text: intent, status: "sent" }], {});
  flow.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_user_input", {
        questions: [{ id: "color", question: "Which color?", options: [{ label: "Blue" }] }],
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxToolCall("write", { path: "color.txt", content: "Blue" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Blue notes saved."),
  ]);
  await flow.main.request("turn/start", {
    clientUserMessageId: "color",
    input: [{ type: "text", text: intent }],
  });
  await eventually(
    hasWork.bind(undefined, flow.parent.id, intent, "waiting"),
    "A real unanswered question must be waiting"
  );
  assert.deepEqual(taskFor(flow.parent.id, intent)?.pendingQuestions, ["Which color?"]);
  const question = flow.events.find(isQuestion.bind(undefined));

  assert.ok(question?.id);
  flow.main.respond(question.id, { answers: { color: { answers: ["Blue"] } } });
  await eventually(
    hasWork.bind(undefined, flow.parent.id, intent, "resolved"),
    "Answered work must finish automatically"
  );
  assert.deepEqual(taskFor(flow.parent.id, intent)?.pendingQuestions, []);
});

await test("voice backend completion stays open until the requested report is actually persisted to chat", async (t) => {
  const replay = new TaskClassifierReplay();
  const intent = "Deliver the synthetic project report to chat.";
  const continuation = "Please deliver that report now.";

  replay.scenarios.set(intent, { outcome: "resolved", requiresDelivery: true, isAnswer: true });
  replay.continuations.set(continuation, { originalIntent: intent });
  t.mock.method(globalThis, "fetch", replay.fetch.bind(replay));
  const flow = await piWorkflow(t, 1, [], classifierCredential);
  const firstId = "realtime-tool:session:first";
  const packet = `Saved old_history_marker and unrelated requests. Current intent: ${intent}`;

  acceptTaskReceipts(
    flow.parent.id,
    [
      {
        id: firstId,
        text: packet,
        status: "sent",
        source: { type: "realtime", sessionId: "session", itemId: "first", intent },
      },
    ],
    {}
  );
  flow.provider.setResponses([fauxAssistantMessage("The report is delivered.")]);
  await flow.send(firstId, packet);
  await eventually(hasAssessment.bind(undefined, flow.parent.id, intent), "Private backend output must be assessed");
  assert.equal(taskFor(flow.parent.id, intent)?.work, "open");
  assert.doesNotMatch(JSON.stringify(replay.requests), /old_history_marker/u);
  const before = readTaskLedger(flow.parent.id);

  assert.equal(taskDelivery(before, before.tasks[0]).state, "not_delivered");
  const secondId = "realtime-tool:session:second";

  acceptTaskReceipts(
    flow.parent.id,
    [
      {
        id: secondId,
        text: continuation,
        status: "sent",
        source: { type: "realtime", sessionId: "session", itemId: "second", intent: continuation },
      },
    ],
    {}
  );
  flow.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("pocket_send_to_chat", { message: "Synthetic project report: all items verified." }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("The report is now in chat."),
  ]);
  await flow.send(secondId, continuation);
  await eventually(
    hasWork.bind(undefined, flow.parent.id, intent, "resolved"),
    "Actual report delivery must resolve work"
  );
  const after = readTaskLedger(flow.parent.id);

  assert.equal(taskDelivery(after, after.tasks[0]).state, "delivered");
});

/** Add a synthetic successful verification with explicit membership for the stale-assessment regression.
@param state - Isolated parent checkpoint.
@returns Evidence-backed input without dispatching any work.
*/
function verifiedSource(state: Ledger) {
  const next = recordEvent(state, {
    id: "verified",
    parentId: state.parentId,
    origin: "tool_result",
    toolName: "read",
    isError: false,
    text: "The synthetic result was verified.",
    visibility: "internal",
    delivery: "not_delivered",
    contentRefs: [],
  });
  const decision = assignmentDecision(
    next,
    "verified",
    { kind: "attach", taskIds: ["work"] },
    "correlation",
    "fixture",
    "Explicit synthetic result ownership."
  );

  return assignEvent(next, decision);
}

await test("a lifecycle assessment arriving after new input is discarded without changing work state", async (t) => {
  await workspace(t);
  await migrateTaskLedger("parent");
  acceptTaskReceipts("parent", [{ id: "work", text: "Verify synthetic work.", status: "sent" }], {});
  await changeTask(
    "parent",
    readTaskLedger("parent").revision,
    {
      kind: "assign",
      eventId: "request:work",
      assignment: { kind: "create", taskId: "work", title: "Synthetic work" },
    },
    "Explicit fixture membership."
  );
  updateTasks("parent", "Record synthetic verification", verifiedSource);
  const replay = new TaskClassifierReplay();
  const gate = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() };

  replay.gate = gate;
  t.mock.method(globalThis, "fetch", replay.fetch.bind(replay));
  const pending = reviewTaskLifecycle("parent", "synthetic-task-key", false);

  await gate.entered.promise;
  acceptTaskReceipts("parent", [{ id: "correction", text: "The requirements have changed.", status: "sent" }], {});
  gate.release.resolve(undefined);
  const state = await pending;

  assert.equal(state.tasks[0].work, "open");
  assert.deepEqual(state.lifecycleReviews, []);
});
