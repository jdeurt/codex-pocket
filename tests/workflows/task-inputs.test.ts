import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
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
