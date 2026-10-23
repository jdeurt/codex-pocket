import {
  activeAssignment,
  correction,
  nativeFlow,
  transcript,
  restartUnknown,
  assertUnknownRecovery,
  fillCapacity,
} from "../fixtures/delegation-native";
import { owner, tool, state, assignment } from "../fixtures/delegation-flow";
import { delegationCommandSchema } from "../../src/server/delegation-data";
import assert from "node:assert/strict";
import test from "node:test";

await test("a Side Pocket receives current corrections, cancels obsolete work and reports its original result once", async (t) => {
  const native = await nativeFlow(t);
  const child = await activeAssignment(native, "voice-inspection", "tool");
  const queued = delegationCommandSchema.parse(
    await tool(native.client, "side_pocket_send", {
      id: child.id,
      message: "Obsolete next assignment",
      mode: "queue",
      idempotencyKey: "obsolete",
    })
  );
  const corrected = await correction(native, child, "Keep the exact voice transcript.", "correction", "accepted", [
    queued.id,
  ]);
  const retried = delegationCommandSchema.parse(
    await tool(native.client, "side_pocket_send", {
      id: child.id,
      message: "Keep the exact voice transcript.",
      idempotencyKey: "correction",
      supersedes: [queued.id],
    })
  );

  assert.equal(retried.id, corrected.id);
  const history = await transcript(native, child);

  assert.equal(history.length, 1);
  assert.deepEqual(
    history[0].items.map((item) => item.text),
    ["tool", "Keep the exact voice transcript."]
  );
  assert.equal(
    native.flow.store.queue.list(owner, child.id).find((command) => command.id === queued.id)?.status,
    "cancelled"
  );
  const command = native.flow.store.queue.list(owner, child.id)[0];
  const reporter = await native.flow.mcp("scripts/side-pocket-mcp.ts", {
    POCKET_CHILD_ID: child.id,
    POCKET_COMMAND_ID: command.id,
  });
  const report = "Original result: voice provenance is intact. ✓";

  await tool(reporter, "message_parent", { message: report });
  await tool(reporter, "message_parent", { message: report });
  await native.worker.until((events) => events.some((event) => event.event === "mail" && event.text.includes(report)));
  await correction(native, child, "finish", "finish", "accepted");
  await state(native.flow.store, () => native.flow.store.get(owner, child.id).status === "idle");
  const reports = native.flow.store.reports.list(owner);

  assert.equal(reports.filter((entry) => entry.text === report).length, 1);
  assert.equal(reports.find((entry) => entry.text === report)?.agentId, `pocket:${child.id}`);
  assert.deepEqual(native.flow.store.reports.list("another-parent"), []);
  const resumed = await tool(native.client, "side_pocket_send", {
    id: child.id,
    message: "Continue the saved inspection",
    idempotencyKey: "follow-up",
  });

  assert.equal(resumed.mode, "steer");
  await native.worker.until((events) =>
    events.some(
      (event) =>
        event.event === "started" && event.childId === child.id && event.text === "ready:Continue the saved inspection"
    )
  );
  const continued = await transcript(native, child);

  assert.equal(continued.length, 2);
  assert.equal(continued[1].items[0].text, "Continue the saved inspection");
});

await test("a lost Side Pocket steering acknowledgement remains unknown after restart without replay", async (t) => {
  const native = await nativeFlow(t);
  const child = await activeAssignment(native, "lost-ack", "tool");
  const receipt = await correction(native, child, "disconnect", "lost-correction", "unknown");

  assert.equal(receipt.status, "unknown");
  await restartUnknown(native, child);
  await assertUnknownRecovery(native, child, receipt);
  const saved = await tool(native.client, "side_pocket_get", { id: child.id });

  assert.equal(saved.status, "unknown");
  const history = await transcript(native, child);

  assert.deepEqual(
    history[0].items.map((item) => item.text),
    ["tool", "disconnect"]
  );
});

await test("Side Pocket capacity queues distinct work until an executing child releases its slot", async (t) => {
  const native = await nativeFlow(t);
  const active = await fillCapacity(native);
  const queued = await tool(
    native.client,
    "side_pocket_create",
    assignment("waiting-for-slot", "codex", "Ninth distinct task")
  );

  // Join an actual dispatch pass while every existing native child still owns its slot.
  await native.worker.call("tick");
  assert.deepEqual(
    native.flow.store
      .list(owner)
      .filter((child) => child.status === "running")
      .map((child) => child.id)
      .toSorted((left, right) => left.localeCompare(right)),
    active.map((child) => child.id).toSorted((left, right) => left.localeCompare(right))
  );
  assert.deepEqual(
    native.worker
      .starts()
      .map((entry) => entry.childId)
      .toSorted((left, right) => left.localeCompare(right)),
    active.map((child) => child.id).toSorted((left, right) => left.localeCompare(right))
  );
  assert.equal(native.flow.store.queue.list(owner, queued.id)[0].status, "queued");
  await correction(native, active[0], "finish", "release-slot", "accepted");
  await native.worker.until((events) =>
    events.some(
      (event) => event.event === "started" && event.childId === queued.id && event.text === "ready:Ninth distinct task"
    )
  );
  const history = await transcript(native, queued);

  assert.equal(history.length, 1);
  assert.equal(history[0].items[0].text, "Ninth distinct task");
  assert.equal(native.flow.store.get(owner, active[0].id).status, "idle");
});
