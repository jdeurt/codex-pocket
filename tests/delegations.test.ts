import { mkdtemp, rm, stat } from "node:fs/promises";
import { DelegationStore } from "../src/server/delegations";
import assert from "node:assert/strict";
import { initialSnapshot } from "../src/lib/protocol";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_MASK = 0o777;
const owner = "parent-chat";
const context = { cwd: "/tmp", policy: { sandbox: "danger-full-access", approval: "never" } };
const assignment = { title: "Investigate", body: "Read the project", idempotencyKey: "work-1" };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-delegation-"));
  const store = new DelegationStore(directory);
  store.saveParent(owner, context);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return { store, directory };
}

test("delegation creation and sends are scoped, durable and idempotent", async (t) => {
  const { store, directory } = await fixture(t);
  const child = store.create(owner, assignment);
  assert.equal(store.create(owner, assignment).id, child.id);
  assert.throws(() => store.create(owner, { ...assignment, body: "Different work" }), /different work/);
  assert.throws(() => store.get("other-parent", child.id), /not found/);
  assert.deepEqual(child.policy, context.policy);
  const first = store.send(owner, child.id, "followup", "Follow up");
  assert.equal(store.send(owner, child.id, "followup", "Follow up").id, first.id);
  assert.throws(() => store.send(owner, child.id, "followup", "Different text"), /different text/);
  store.setSession(owner, child.id, "saved-native-session");
  const reopened = new DelegationStore(directory);
  assert.equal(reopened.get(owner, child.id).sessionId, "saved-native-session");
  reopened.close();
  const info = await stat(path.join(directory, "delegations.sqlite"));
  assert.equal(info.mode & PERMISSION_MASK, PRIVATE_FILE_MODE);
});

test("close cancels queued work and resume keeps the same child and saved session", async (t) => {
  const { store } = await fixture(t);
  const child = store.create(owner, assignment);
  store.setSession(owner, child.id, "saved");
  const first = store.claim(owner, child.id);
  assert.ok(first);
  store.send(owner, child.id, "second", "Queued work");
  assert.equal(store.claim(owner, child.id), undefined);
  store.closeChild(owner, child.id);
  assert.equal(store.commands(owner, child.id)[1].status, "cancelled");
  assert.throws(() => store.send(owner, child.id, "third", "New work"), /Resume/);
  assert.throws(() => store.resume(owner, child.id), /still closing/);
  store.finish(first, "cancelled", "Closed");
  store.setStatus(owner, child.id, "closed");
  const resumed = store.resume(owner, child.id);
  assert.equal(resumed.id, child.id);
  assert.equal(resumed.sessionId, "saved");
  assert.equal(resumed.status, "idle");
  store.send(owner, child.id, "third", "New work");
  assert.equal(store.claim(owner, child.id)?.body, "New work");
});

test("child messages route by managed identity, deduplicate retries and reject inactive turns", async (t) => {
  const { store } = await fixture(t);
  const child = store.create(owner, assignment);
  const command = store.claim(owner, child.id);
  assert.ok(command);
  const first = store.mail.message(child.id, command.id, { message: "Which color?" });
  assert.equal(store.mail.message(child.id, command.id, { message: "Which color?" }).id, first.id);
  assert.equal(store.mail.pending(owner).length, 1);
  assert.deepEqual(store.mail.pending("other-parent"), []);
  assert.throws(() => store.mail.message(child.id, command.id, { message: "Hi", parentId: "other" }));
  store.closeChild(owner, child.id);
  assert.throws(() => store.mail.message(child.id, command.id, { message: "Late message" }), /no longer active/);
});

test("restarts preserve reports and identities without replaying uncertain child work", async (t) => {
  const { store, directory } = await fixture(t);
  const child = store.create(owner, assignment);
  const command = store.claim(owner, child.id);
  assert.ok(command);
  store.setSession(owner, child.id, "native-session");
  const reopened = new DelegationStore(directory);
  reopened.recover(owner);
  reopened.recover(owner);
  assert.equal(reopened.get(owner, child.id).sessionId, "native-session");
  assert.equal(reopened.get(owner, child.id).status, "unknown");
  assert.equal(reopened.commands(owner, child.id)[0].status, "unknown");
  assert.equal(reopened.mail.pending(owner).length, 1);
  assert.equal(reopened.claim(owner, child.id), undefined);
  assert.throws(() => reopened.send(owner, child.id, "followup", "Continue"), /Resume/);
  reopened.resume(owner, child.id);
  const next = reopened.send(owner, child.id, "followup", "Continue from saved work");
  assert.equal(reopened.claim(owner, child.id)?.id, next.id);
  reopened.close();
});

test("harness answers are validated before persistence and remain parent scoped", async (t) => {
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

test("delegate reports stay internal while ordinary chat and parent replies remain visible", () => {
  const reportId = "pocket-delegate:report-id";
  const snapshot = structuredClone(initialSnapshot);
  snapshot.queue.push({ id: reportId, text: "Internal child report", status: "queued" });
  snapshot.turns.push({
    id: "turn",
    status: "completed",
    items: [
      { id: "report", type: "userMessage", clientId: reportId, content: [{ type: "text", text: "Child report" }] },
      { id: "human", type: "userMessage", content: [{ type: "text", text: "Human message" }] },
      { id: "reply", type: "agentMessage", text: "Parent summary" },
    ],
  });
  const visible = visibleSnapshot(snapshot);
  assert.equal(visible.queue.length, 0);
  assert.deepEqual(
    visible.turns[0].items.map((item) => item.id),
    ["human", "reply"]
  );
});
