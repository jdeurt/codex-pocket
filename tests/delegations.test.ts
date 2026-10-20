import { type DelegationCommand, type SidePocket } from "../src/server/delegation-data";
import { type Snapshot, initialSnapshot } from "../src/lib/protocol";
import { mkdtemp, rm, stat } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { DelegationStore } from "../src/server/delegations";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_MASK = 0o777;
const owner = "parent-chat";
const context = { cwd: "/tmp", policy: { sandbox: "danger-full-access", approval: "never" } };
const assignment = { title: "Investigate", body: "Read the project", idempotencyKey: "work-1" };

/**
Creates private durable delegation storage and registers its native cleanup.
@param t - Native test lifecycle receiving asynchronous store and directory cleanup.
@returns Owned store and private directory.
*/
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-delegation-"));
  const store = new DelegationStore(directory);

  store.saveParent(owner, context);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return { store, directory };
}

/**
Checks creation scope and retry identity before queueing the original followup.
@param store - Private native store configured for this parent.
@param child - Canonical created child used by the scoped assertions.
@returns Persisted followup command.
*/
function scopedFollowup(store: DelegationStore, child: SidePocket) {
  assert.equal(store.create(owner, assignment).id, child.id);
  assert.throws(() => store.create(owner, { ...assignment, body: "Different work" }), /different work/);
  assert.throws(() => store.get("other-parent", child.id), /not found/);
  assert.deepEqual(child.policy, context.policy);

  return store.queue.send(owner, child.id, "followup", "Follow up");
}

/**
Checks followup idempotency before saving the native session and reopening its store.
@param store - Original private native store.
@param directory - Private durable database directory.
@param child - Original canonical child identity.
@param first - Original canonical queued command.
@returns Reopened native store after persisted session assignment.
*/
function reopenedSession(store: DelegationStore, directory: string, child: SidePocket, first: DelegationCommand) {
  assert.equal(store.queue.send(owner, child.id, "followup", "Follow up").id, first.id);
  assert.throws(() => store.queue.send(owner, child.id, "followup", "Different text"), /different text/);
  store.setSession(owner, child.id, "saved-native-session");

  return new DelegationStore(directory);
}

/**
Requires the saved session through the reopened database and closes that handle before reading metadata.
@param reopened - Second native database handle owned by this verification phase.
@param directory - Private database directory.
@param child - Original child whose session must survive reopening.
@returns Native database file metadata after the reopened handle is closed.
*/
async function persistedSessionMetadata(reopened: DelegationStore, directory: string, child: SidePocket) {
  try {
    assert.equal(reopened.get(owner, child.id).sessionId, "saved-native-session");
  } finally {
    reopened.close();
  }

  return stat(path.join(directory, "delegations.sqlite"));
}

await test("delegation creation and sends are scoped, durable and idempotent", async (t) => {
  const { store, directory } = await fixture(t);
  const child = store.create(owner, assignment);

  const first = scopedFollowup(store, child);
  const reopened = reopenedSession(store, directory, child, first);
  const info = await persistedSessionMetadata(reopened, directory, child);

  assert.equal(info.mode & PERMISSION_MASK, PRIVATE_FILE_MODE);
});

/**
Persists the saved native identity before claiming its initial command.
@param store - Private native parent store.
@param child - Canonical child whose saved session is retained.
@returns Native command claim required by the cancellation phase.
*/
function savedAssignment(store: DelegationStore, child: SidePocket) {
  store.setSession(owner, child.id, "saved");

  return store.queue.claim(owner, child.id);
}

/**
Checks queued cancellation and confirmed closure before resuming the same saved child.
@param store - Private native parent store.
@param child - Original canonical child identity.
@returns Canonical resumed child after the closed assignment is finished.
*/
function resumedSavedChild(store: DelegationStore, child: SidePocket) {
  const first = savedAssignment(store, child);

  assert.ok(first);
  store.queue.send(owner, child.id, "second", "Queued work");
  assert.equal(store.queue.claim(owner, child.id), undefined);
  store.closeChild(owner, child.id);
  assert.equal(store.queue.list(owner, child.id)[1].status, "cancelled");
  assert.throws(() => store.queue.send(owner, child.id, "third", "New work"), /Resume/);
  assert.throws(() => store.resume(owner, child.id), /still closing/);
  store.queue.finish(first, "cancelled", "Closed");
  store.setStatus(owner, child.id, "closed");

  return store.resume(owner, child.id);
}

await test("close cancels queued work and resume keeps the same child and saved session", async (t) => {
  const { store } = await fixture(t);
  const child = store.create(owner, assignment);

  const resumed = resumedSavedChild(store, child);

  assert.equal(resumed.id, child.id);
  assert.equal(resumed.sessionId, "saved");
  assert.equal(resumed.status, "idle");
  store.queue.send(owner, child.id, "third", "New work");
  assert.equal(store.queue.claim(owner, child.id)?.body, "New work");
});

/**
Requires an actual claimed command before persisting its first parent report.
@param store - Private native parent store.
@param child - Canonical managed child identity.
@returns Canonical claimed command and its persisted first report.
*/
function firstChildReport(store: DelegationStore, child: SidePocket) {
  const command = store.queue.claim(owner, child.id);

  assert.ok(command);

  return { command, first: store.mail.message(child.id, command.id, { message: "Which color?" }) };
}

await test("child messages route by managed identity, deduplicate retries and reject inactive turns", async (t) => {
  const { store } = await fixture(t);
  const child = store.create(owner, assignment);
  const { command, first } = firstChildReport(store, child);

  assert.equal(store.mail.message(child.id, command.id, { message: "Which color?" }).id, first.id);
  assert.equal(store.mail.pending(owner).length, 1);
  assert.deepEqual(store.mail.pending("other-parent"), []);
  assert.throws(() => store.mail.message(child.id, command.id, { message: "Hi", parentId: "other" }));
  store.closeChild(owner, child.id);
  assert.throws(() => store.mail.message(child.id, command.id, { message: "Late message" }), /no longer active/);
});

/**
Requires the initial command before persisting its native session and opening a recovery handle.
@param store - Original private native store.
@param directory - Private database directory.
@param child - Canonical child with active persisted work.
@returns Reopened native store for recovery assertions.
*/
function recoveryStore(store: DelegationStore, directory: string, child: SidePocket) {
  const command = store.queue.claim(owner, child.id);

  assert.ok(command);
  store.setSession(owner, child.id, "native-session");

  return new DelegationStore(directory);
}

/**
Checks idempotent recovery and uncertain-work rejection before an explicit saved-session continuation.
@param reopened - Reopened native store whose lifetime belongs to the caller.
@param child - Original canonical child identity.
@returns Explicitly queued continuation command after inspection and resume.
*/
function inspectedContinuation(reopened: DelegationStore, child: SidePocket) {
  reopened.recover(owner);
  reopened.recover(owner);
  assert.equal(reopened.get(owner, child.id).sessionId, "native-session");
  assert.equal(reopened.get(owner, child.id).status, "unknown");
  assert.equal(reopened.queue.list(owner, child.id)[0].status, "unknown");
  assert.equal(reopened.mail.pending(owner).length, 1);
  assert.equal(reopened.queue.claim(owner, child.id), undefined);
  assert.throws(() => reopened.queue.send(owner, child.id, "followup", "Continue"), /Resume/);
  reopened.resume(owner, child.id);

  return reopened.queue.send(owner, child.id, "followup", "Continue from saved work");
}

/**
Checks the explicitly resumed command identity and always closes the recovery handle.
@param reopened - Second native store handle owned by this phase.
@param child - Original canonical child identity.
*/
function assertRecoveredContinuation(reopened: DelegationStore, child: SidePocket) {
  try {
    const next = inspectedContinuation(reopened, child);

    assert.partialDeepStrictEqual(reopened.queue.claim(owner, child.id), { id: next.id });
  } finally {
    reopened.close();
  }
}

await test("restarts preserve reports and identities without replaying uncertain child work", async (t) => {
  const { store, directory } = await fixture(t);
  const child = store.create(owner, assignment);
  const reopened = recoveryStore(store, directory, child);

  assertRecoveredContinuation(reopened, child);
});

await test("harness answers are validated before persistence and remain parent scoped", async (t) => {
  const { store } = await fixture(t);
  const child = store.create(owner, assignment);
  const id = store.mail.request(owner, child.id, {
    id: "native-id",
    kind: "question",
    method: "item/tool/requestUserInput",
    input: { questions: [{ id: "color" }] },
  });

  assert.throws(() => store.mail.answer(owner, child.id, id, { answers: {} }), /Answer each/);
  assert.equal(store.mail.requests(owner, child.id)[0].status, "pending");
  assert.throws(() => store.mail.answer("other", child.id, id, {}), /no longer waiting/);
  store.mail.answer(owner, child.id, id, { answers: { color: { answers: ["Blue"] } } });
  assert.equal(store.mail.requests(owner, child.id)[0].status, "answered");
});

await test("delegate reports stay internal while ordinary chat and parent replies remain visible", () => {
  const reportId = "pocket-delegate:report-id";
  const snapshot: Snapshot = {
    ...structuredClone(initialSnapshot),
    queue: [{ id: reportId, text: "Internal child report", status: "queued" }],
    turns: [
      {
        id: "turn",
        status: "completed",
        items: [
          { id: "report", type: "userMessage", clientId: reportId, content: [{ type: "text", text: "Child report" }] },
          { id: "human", type: "userMessage", content: [{ type: "text", text: "Human message" }] },
          { id: "reply", type: "agentMessage", text: "Parent summary" },
        ],
      },
    ],
  };
  const visible = visibleSnapshot(snapshot);

  assert.equal(visible.queue.length, 0);
  assert.deepEqual(
    visible.turns[0].items.map((item) => item.id),
    ["human", "reply"]
  );
});
