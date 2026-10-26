import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { piWorkflow } from "../fixtures/pi-workflow";
import { readTaskSources, type TaskSource } from "../../src/tasks/sources";
import { TaskRepository } from "../../src/tasks/repository";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { t as capture } from "try";
import { object, type RpcEvent } from "../../src/lib/protocol";
import { classifiedCheckpoint } from "../../src/tasks/classification-runtime";
import { hasEventId, hasTaskId } from "../../src/tasks/transitions";
import type { Ledger } from "../../src/tasks/model";
import { workspace, eventually } from "../fixtures/workflow";
import { acceptTaskReceipts } from "../../src/tasks/ingestion";
import { taskDirectory, writeTaskFile, saveTaskSource } from "../../src/tasks/archive";
import { migrateTaskLedger } from "../../src/tasks/migration";
import { readTaskLedger, changeTask } from "../../src/tasks/management";
import { reconcileTaskViews } from "../../src/tasks/retrieval/views";
import { searchTaskArchivePage } from "../../src/tasks/retrieval/runtime";
import { taskProjectionName } from "../../src/tasks/projection-model";
import { proposeTaskAssignment } from "../../src/tasks/proposals";
import type { ContextEntry } from "../../src/tasks/archive-model";

const FIRST_TASK = "20000000-0000-4000-8000-000000000001";
const SECOND_TASK = "10000000-0000-4000-8000-000000000002";

/** Save an old chronological envelope with explicit membership, including unrelated surrounding context.
@param taskId - Historical task identity.
@param matched - Explicit old matched user IDs.
@param entries - Exact chronological records.
@returns Original archive bytes for immutability verification.
*/
async function oldArchive(taskId: string, matched: string[], entries: ContextEntry[]) {
  const body = JSON.stringify({
    metadata: { id: taskId, owner: "parent", anchor: matched[0], matched, status: "closed" },
    entries,
  });

  await writeTaskFile(taskDirectory("parent"), `${taskId}.json`, body);
  await writeTaskFile(taskDirectory("parent"), `${taskId}.md`, `# Legacy task ${taskId}\n`);

  return body;
}

/** Return a deterministic old source with its exact native identity.
@param id - Native source ID.
@param sequence - Recorded source order.
@param text - Exact original request.
@returns Original source fixture.
*/
function oldSource(id: string, sequence: number, text: string): ContextEntry {
  return {
    id,
    sequence,
    role: "user",
    text,
    original: {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: text },
    },
  };
}

/** Read retained fixture evidence through its exact parent path.
@param name - Host-authored relative fixture filename.
@returns Exact original bytes.
*/
function retainedFile(name: string) {
  return readFile(path.join(taskDirectory("parent"), name), "utf8");
}

await test("legacy rollout preserves memberships and exact originals while search indexes interleaved sources once after repair", async (t) => {
  await workspace(t);
  const first = oldSource("first", 0, "Prepare launchcalendarfixture EPD leadership update.");
  const second = oldSource("second", 1, "Update Pocket software.");

  await saveTaskSource("parent", first);
  await saveTaskSource("parent", second);
  const firstBytes = await oldArchive(FIRST_TASK, [first.id], [first, second]);
  const secondBytes = await oldArchive(SECOND_TASK, [second.id], [second]);
  const before = await retainedFile("source/0.json");
  const state = await migrateTaskLedger("parent");

  assert.equal(state.mode, "live");
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0].work, "open", "Old closed groups do not establish completion");
  assert.equal(state.tasks[0].retention, "archived");
  assert.equal(state.tasks[0].authority, "legacy");
  assert.equal(state.tasks.find(hasTaskId.bind(undefined, FIRST_TASK))?.originalIntent, first.text);
  assert.equal(state.commands.length, 0, "Migration must not replay delegate commands");
  const retry = await migrateTaskLedger("parent");

  assert.deepEqual(retry, state, "Migration restart must be idempotent");
  const documents = await reconcileTaskViews("parent");

  assert.equal(documents[0].sequence, 0);
  assert.equal(documents[1].sequence, 1);
  assert.equal(documents.length, 2, "Duplicated chronological envelopes must yield each source passage once");
  const updated = await changeTask(
    "parent",
    state.revision,
    { kind: "move", eventId: "native:first", taskIds: [SECOND_TASK] },
    "Reviewed historical membership correction."
  );
  const projection = await readFile(path.join(taskDirectory("parent"), taskProjectionName(SECOND_TASK)), "utf8");

  assert.match(projection, /native:first/);
  assert.match(projection, /launchcalendarfixture/);
  assert.equal(updated.tasks.find(hasTaskId.bind(undefined, FIRST_TASK))?.originalIntent, first.text);
  assert.equal(await retainedFile(`${FIRST_TASK}.json`), firstBytes);
  assert.equal(await retainedFile(`${SECOND_TASK}.json`), secondBytes);
  assert.equal(await retainedFile("source/0.json"), before);
  const invalid = await capture(saveTaskSource, "parent", { ...first, text: "Different original" });

  assert.equal(invalid.ok, false);
  assert.equal(await retainedFile("source/0.json"), before);
  const page = await searchTaskArchivePage("parent", "launchcalendarfixture", 0);

  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].source.id, "first");
  assert.equal(page.results[0].taskAssociations[0]?.taskId, SECOND_TASK);
  assert.equal(page.retrieval.mode, "keyword");
});

/** Return synthetic provider evidence for a review proposal without modifying the ledger.
@returns Exact canned predicate response.
*/
function proposalResponse() {
  return Promise.resolve(
    Response.json({
      answers: [
        { type: "predicate", name: "actionable", probability: 1 },
        { type: "predicate", name: "independent", probability: 1 },
        { type: "predicate", name: "cancel", probability: 0 },
        { type: "predicate", name: "correction", probability: 0 },
      ],
    })
  );
}

await test("historical reclassification stays a reviewable proposal until its concrete operation is explicitly applied", async (t) => {
  await workspace(t);
  const first = oldSource("historical", 0, "Find the synthetic project list sent to Marc.");

  await saveTaskSource("parent", first);
  acceptTaskReceipts("parent", [{ id: "historical-receipt", text: first.text, status: "sent" }], {});
  await migrateTaskLedger("parent");
  // No existing explicit membership is invented for an ungrouped historical request.
  const before = readTaskLedger("parent");

  assert.deepEqual(before.tasks, []);
  const missing = await capture(proposeTaskAssignment, "parent", "native:historical", "synthetic-key");

  assert.equal(missing.ok, false, "Unknown historical request provenance cannot be invented by the classifier");
  t.mock.method(globalThis, "fetch", proposalResponse);
  const proposal = await proposeTaskAssignment("parent", "request:historical-receipt", "synthetic-key");

  assert.equal(proposal.applied, false);
  assert.deepEqual(readTaskLedger("parent"), before);
  const applied = await changeTask(
    "parent",
    proposal.expectedRevision,
    proposal.operation,
    "Explicitly reviewed and approved historical assignment proposal."
  );

  assert.equal(applied.tasks.length, 1);
  assert.deepEqual(applied.events, before.events);
  assert.deepEqual(applied.commands, []);
});

/** Read exact native source bytes for restart-window verification.
@param source - Validated original reference.
@returns Exact bytes, including native identities.
*/
function originalBytes(source: TaskSource) {
  return readFile(source.file, "utf8");
}

await test("Pi reconciles sources written before a cursor commit without duplicating originals or replaying uncertain input", async (t) => {
  const flow = await piWorkflow(t, 2);

  acceptTaskReceipts(flow.parent.id, [{ id: "uncertain", text: "Find the project list.", status: "unknown" }], {});
  flow.provider.setResponses([fauxAssistantMessage("Project list recorded.")]);
  await flow.send("uncertain", "Find the project list.");
  await flow.main.close();
  const state = readTaskLedger(flow.parent.id);
  const before = await readTaskSources(flow.parent.id);
  const bytes = await Promise.all(Array.from(before, originalBytes));
  const repository = new TaskRepository(flow.parent.id);

  flow.cleanup(repository.close.bind(repository));
  repository.commit({ ...state, cursor: null }, "Simulate an interrupted source checkpoint commit.");
  const resumed = flow.create();

  await resumed.request("thread/resume", {});
  await resumed.close();
  const after = await readTaskSources(flow.parent.id);
  const restored = readTaskLedger(flow.parent.id);

  assert.equal(after.length, before.length);
  assert.deepEqual(await Promise.all(Array.from(after, originalBytes)), bytes);
  assert.deepEqual(restored.events, state.events);
  assert.deepEqual(restored.bindings, state.bindings);
  assert.deepEqual(restored.commands, state.commands);
  assert.equal(restored.nextSequence, state.nextSequence);
});

/** Observe a real pending native question.
@param event - Canonical SDK event.
@returns Whether this is a pending request.
*/
function isQuestion(event: RpcEvent) {
  return event.id !== undefined;
}

/** Wait on the canonical question boundary.
@param events - Explicit observed SDK events.
@returns Whether a native question exists.
*/
function hasQuestion(events: RpcEvent[]) {
  return events.some(isQuestion.bind(undefined));
}

/** Observe completion of the real native run.
@param events - Explicit observed SDK events.
@returns Whether the run completed.
*/
function hasCompletion(events: RpcEvent[]) {
  for (const event of events) {
    if (event.method === "turn/completed") {
      return true;
    }
  }

  return false;
}

/** Select a native output whose recorded run consumed multiple requests.
@param event - Persisted source event.
@returns Whether this output has multiple explicit request origins.
*/
function hasMultipleOrigins(event: Ledger["events"][number]) {
  return event.origin === "assistant" && event.requestIds.length > 1;
}

/** Commit synthetic intent evidence for an explicit independent request.
@param repository - Actual private ledger.
@param id - Request event identity.
@param taskId - Stable task identity.
*/
function independentTask(repository: TaskRepository, id: string, taskId: string) {
  const state = repository.read();
  const event = state.events.find(hasEventId.bind(undefined, id));

  assert.ok(event);
  repository.commit(
    classifiedCheckpoint(
      state,
      event,
      { actionable: 1, independent: 1, cancel: 0, correction: 0, matches: [] },
      taskId
    ),
    "Canned independent intent."
  );
}

await test("native output with unrelated consumed requests stays unresolved instead of following the latest user", async (t) => {
  const flow = await piWorkflow(t);

  acceptTaskReceipts(
    flow.parent.id,
    [
      { id: "projects", text: "Find the project list sent to Marc.", status: "sent" },
      { id: "software", text: "Update Pocket software.", status: "sent" },
    ],
    {}
  );
  flow.provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_user_input", {
        questions: [{ id: "format", question: "Which project list format?", options: [{ label: "Link" }] }],
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("The original project list is ready."),
  ]);
  const started = object(
    await flow.main.request("turn/start", {
      clientUserMessageId: "projects",
      input: [{ type: "text", text: "Find the project list sent to Marc." }],
    })
  );

  await eventually(hasQuestion.bind(undefined, flow.events), "Pi must ask its real native question");
  const question = flow.events.find(isQuestion.bind(undefined));

  assert.ok(question?.id);
  await flow.main.request("turn/steer", {
    expectedTurnId: object(started.turn).id,
    clientUserMessageId: "software",
    input: [{ type: "text", text: "Update Pocket software." }],
  });
  flow.main.respond(String(question.id), { answers: { format: { answers: ["Link"] } } });
  await eventually(hasCompletion.bind(undefined, flow.events), "Pi must finish both accepted inputs");
  await flow.main.close();
  const repository = new TaskRepository(flow.parent.id);

  flow.cleanup(repository.close.bind(repository));
  independentTask(repository, "request:projects", "projects-task");
  independentTask(repository, "request:software", "software-task");
  const state = repository.read();
  const output = state.events.find(hasMultipleOrigins.bind(undefined));

  assert.ok(output, "The native output must retain both consumed request identities");

  for (const member of state.memberships) {
    assert.notEqual(member.eventId, output.id, "Unrelated origins cannot be reduced to the latest request");
  }
});
