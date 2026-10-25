import test from "node:test";
import assert from "node:assert/strict";
import { t as capture } from "try";
import { workspace } from "../fixtures/workflow";
import { acceptTaskReceipts } from "../../src/tasks/ingestion";
import { TaskRepository } from "../../src/tasks/repository";
import { readTaskLedger, changeTask } from "../../src/tasks/management";
import { classifiedCheckpoint, classifyTaskLedger } from "../../src/tasks/classification-runtime";
import { planTaskContext, taskDelivery } from "../../src/tasks/context";
import { hasEventId } from "../../src/tasks/transitions";
import type { IntentEvidence } from "../../src/tasks/interpretation";
import type { Ledger } from "../../src/tasks/model";

const LAST = -1;
const CONTEXT_BUDGET = 12_000;
const independent: IntentEvidence = { actionable: 1, independent: 1, cancel: 0, correction: 0, matches: [] };

/** Commit a canned interpretation through the actual transactional repository.
@param repository - Private persistence owner.
@param receiptId - Accepted current request.
@param taskId - Explicit generated task identity.
@param evidence - Synthetic provider evidence; no model quality is claimed.
@returns Committed checkpoint.
*/
function interpreted(repository: TaskRepository, receiptId: string, taskId: string, evidence = independent) {
  const state = repository.read();
  const event = state.events.find(hasEventId.bind(undefined, `request:${receiptId}`));

  assert.ok(event);

  return repository.commit(classifiedCheckpoint(state, event, evidence, taskId), "Synthetic interpretation");
}

/** Select original event texts to verify repairs preserve source evidence.
@param event - Source event.
@returns Original intent text.
*/
function eventText(event: Ledger["events"][number]) {
  return event.text;
}

/** Identify the explicit multi-task source.
@param member - Recorded membership.
@returns Whether the association belongs to that source.
*/
function isBothMember(member: Ledger["memberships"][number]) {
  return member.eventId === "request:both";
}

await test("task lifecycle keeps completion, retention and delivery separate and repairs membership without rewriting evidence", async (t) => {
  await workspace(t);
  acceptTaskReceipts(
    "parent",
    [
      { id: "epd", text: "Prepare the synthetic EPD leadership update.", status: "sent" },
      { id: "software", text: "Update Pocket software.", status: "sent" },
      { id: "both", text: "Review EPD. Update Pocket.", status: "sent" },
    ],
    {}
  );
  const repository = new TaskRepository("parent");

  t.after(repository.close.bind(repository));
  interpreted(repository, "epd", "epd-task");
  let state = interpreted(repository, "software", "software-task");

  const originals = Array.from(state.events, eventText);

  state = changeTask(
    "parent",
    state.revision,
    {
      kind: "work",
      taskId: "epd-task",
      work: "waiting",
      evidence: ["request:epd"],
      pendingQuestions: ["Which reporting period?"],
      summary: "Awaiting reporting period.",
    },
    "The reporting period is missing."
  );
  state = changeTask(
    "parent",
    state.revision,
    { kind: "retain", taskId: "epd-task", retention: "archived" },
    "Release foreground context."
  );
  assert.equal(state.tasks[0].work, "waiting");
  const context = planTaskContext(state, CONTEXT_BUDGET);

  assert.match(context.text, /Which reporting period/);
  assert.equal(planTaskContext(state, 1).canCompact, false);
  assert.equal(
    capture(
      changeTask,
      "parent",
      state.revision,
      { kind: "work", taskId: "epd-task", work: "resolved", evidence: ["request:software"] },
      "Wrong evidence"
    ).ok,
    false
  );
  state = changeTask(
    "parent",
    state.revision,
    { kind: "work", taskId: "epd-task", work: "resolved", evidence: ["request:epd"], pendingQuestions: [] },
    "Explicitly acknowledged result."
  );
  assert.equal(taskDelivery(state, state.tasks[0]).state, "not_delivered");
  state = changeTask(
    "parent",
    state.revision,
    { kind: "work", taskId: "epd-task", work: "open", evidence: ["request:epd"] },
    "A correction reopens the work."
  );
  state = changeTask(
    "parent",
    state.revision,
    {
      kind: "move",
      eventId: "request:both",
      taskIds: ["epd-task", "software-task"],
      spans: [
        { taskId: "epd-task", start: 0, end: 11 },
        { taskId: "software-task", start: 12, end: 26 },
      ],
    },
    "Reviewed separate content spans."
  );
  assert.equal(state.memberships.filter(isBothMember.bind(undefined)).length, 2);
  state = changeTask(
    "parent",
    state.revision,
    {
      kind: "split",
      taskId: "software-task",
      newTaskId: "update-task",
      title: "Separate update",
      eventIds: ["request:software"],
    },
    "Reviewed split."
  );
  state = changeTask(
    "parent",
    state.revision,
    { kind: "merge", taskIds: ["update-task", "software-task"], targetTaskId: "software-task" },
    "Reviewed merge."
  );
  assert.deepEqual(Array.from(state.events, eventText), originals);
  assert.equal(state.tasks[0].originalIntent, originals[0]);
  assert.equal(state.tasks[0].work, "open");
  assert.equal(capture(repository.commit.bind(repository), { ...state, events: [] }, "Rewrite history").ok, false);
  assert.deepEqual(readTaskLedger("parent"), state);
});

await test("canned intent evidence preserves greetings, ambiguous multi-task requests and contextual cancellation of archived work", async (t) => {
  await workspace(t);
  acceptTaskReceipts(
    "parent",
    [
      { id: "work", text: "Update Pocket software.", status: "sent" },
      { id: "j", text: "j", status: "sent" },
      { id: "k", text: "k", status: "sent" },
      { id: "nice", text: "Nice", status: "sent" },
      { id: "stop", text: "stop", status: "sent" },
    ],
    {}
  );
  const repository = new TaskRepository("parent");

  t.after(repository.close.bind(repository));
  let state = interpreted(repository, "work", "software-task");

  state = changeTask(
    "parent",
    state.revision,
    { kind: "retain", taskId: "software-task", retention: "archived" },
    "Context retention only."
  );

  for (const greeting of ["j", "k", "nice"]) {
    state = interpreted(repository, greeting, `unused:${greeting}`, { ...independent, actionable: 0, independent: 0 });
  }

  assert.equal(state.tasks.length, 1);
  state = interpreted(repository, "stop", "unused:stop", {
    ...independent,
    independent: 0,
    cancel: 1,
    matches: [{ taskId: "software-task", probability: 1 }],
  });
  assert.equal(state.tasks[0].work, "canceled");
  assert.equal(state.tasks[0].retention, "archived");
  assert.equal(state.tasks.length, 1);
  acceptTaskReceipts(
    "parent",
    [
      { id: "epd", text: "Prepare the synthetic EPD update.", status: "sent" },
      { id: "both", text: "Review both updates.", status: "sent" },
      { id: "correction", text: "Correct the software update and continue.", status: "sent" },
    ],
    {}
  );
  interpreted(repository, "epd", "epd-task");
  state = interpreted(repository, "both", "unused:both", {
    ...independent,
    independent: 0,
    matches: [
      { taskId: "software-task", probability: 1 },
      { taskId: "epd-task", probability: 1 },
    ],
  });
  assert.equal(state.decisions.at(LAST)?.assignment.kind, "unresolved");
  state = interpreted(repository, "correction", "unused:correction", {
    ...independent,
    independent: 0,
    correction: 1,
    matches: [
      { taskId: "software-task", probability: 1 },
      { taskId: "epd-task", probability: 0 },
    ],
  });
  assert.equal(state.tasks[0].work, "open");
});

interface DeferredClassifier {
  entered: PromiseWithResolvers<undefined>;
  reply: PromiseWithResolvers<Response>;
}

/** Delay the real classifier's external HTTP response to exercise concurrent acceptance.
@param fixture - Deferred external provider boundary.
@param url - Requested URL.
@param options - Exact outgoing request.
@returns Controlled external response.
*/
function delayedClassifier(fixture: DeferredClassifier, url: unknown, options: RequestInit) {
  assert.equal(url, "https://api.openai.com/v1/decisions");
  assert.equal(options.method, "POST");
  fixture.entered.resolve(undefined);

  return fixture.reply.promise;
}

await test("background classifier discards stale evidence when a new request is accepted", async (t) => {
  await workspace(t);
  acceptTaskReceipts("parent", [{ id: "first", text: "Find the project list.", status: "sent" }], {});
  const fixture = { entered: Promise.withResolvers<undefined>(), reply: Promise.withResolvers<Response>() };

  t.mock.method(globalThis, "fetch", delayedClassifier.bind(undefined, fixture));
  const running = classifyTaskLedger("parent", "synthetic-key");

  await fixture.entered.promise;
  acceptTaskReceipts("parent", [{ id: "second", text: "Update software.", status: "sent" }], {});
  fixture.reply.resolve(
    Response.json({
      answers: [
        { type: "predicate", name: "actionable", probability: 1 },
        { type: "predicate", name: "independent", probability: 1 },
        { type: "predicate", name: "cancel", probability: 0 },
        { type: "predicate", name: "correction", probability: 0 },
      ],
    })
  );
  const state = await running;

  assert.equal(state.events.length, 2);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.decisions, []);
});
