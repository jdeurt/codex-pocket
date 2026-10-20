import {
  type NativeFlow,
  activeAssignment,
  assertUnknownRecovery,
  correction,
  fillCapacity,
  nativeFlow,
  transcript,
} from "./fixtures/delegation-native";
import { type SidePocket, delegationCommandSchema } from "../src/server/delegation-data";
import { TEST_TIMEOUT_MS, assignment, owner, state, tool } from "./fixtures/delegation-flow";
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

/**
Join abrupt fake host exit before starting recovery in a new process.
@param native - Owned offline worker, never a live Pocket service.
*/
async function crashWorker(native: NativeFlow) {
  const exited = once(native.worker.child, "exit");

  native.worker.child.kill("SIGKILL");
  await exited;
}

/**
Crash only the owned fake worker after native consumption but before acknowledgement.
@param native - Offline native flow with a live worker and private saved history.
@param child - Managed child receiving the deliberately unacknowledged correction.
@returns Original durable correction identity, still sending at the crash boundary.
*/
async function crashDuringDelivery(native: NativeFlow, child: SidePocket) {
  const receipt = delegationCommandSchema.parse(
    await tool(native.client, "side_pocket_send", {
      id: child.id,
      message: "hold-ack",
      idempotencyKey: "crash-attempt",
    })
  );

  await native.worker.until((events) =>
    events.some((event) => event.event === "started" && event.childId === child.id && event.text === "held-ack")
  );
  assert.equal(
    native.flow.store.queue.list(owner, child.id).find((command) => command.id === receipt.id)?.status,
    "sending"
  );
  await crashWorker(native);

  return receipt;
}

await test(
  "worker restart preserves a native-consumed unacknowledged correction as unknown and never replays it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const native = await nativeFlow(t);
    const child = await activeAssignment(native, "crash-delivery", "tool");
    const receipt = await crashDuringDelivery(native, child);

    await native.flow.peer("native");
    await assertUnknownRecovery(native, child, receipt);
  }
);

/**
Verify a never-started child's correction reached its first task rather than creating an earlier task.
@param native - Owned offline flow after a slot has become available.
@param child - Initially capacity-blocked child.
@param key - Stable correction key recorded before its initial execution.
*/
async function verifyFirstTask(native: NativeFlow, child: SidePocket, key: string) {
  const receipt = await correction(native, child, "clarify first task", key, "accepted");
  const history = await transcript(native, child);

  assert.equal(history.length, 1);
  assert.deepEqual(
    history[0].items.map((item) => item.text),
    ["tool", "clarify first task"]
  );
  assert.equal(receipt.turnId, history[0].id);
}

await test(
  "corrections for a capacity-blocked new child attach to its first assignment without running ahead of it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const native = await nativeFlow(t);
    const children = await fillCapacity(native);
    const child = await tool(native.client, "side_pocket_create", assignment("waiting-first-task", "codex", "tool"));
    const pending = delegationCommandSchema.parse(
      await tool(native.client, "side_pocket_send", {
        id: child.id,
        message: "clarify first task",
        idempotencyKey: "first-task-correction",
      })
    );
    const initial = native.flow.store.queue.list(owner, child.id)[0];

    assert.equal(pending.status, "pending");
    assert.equal(pending.targetId, initial.id);
    assert.equal(initial.status, "queued");
    await correction(native, children[0], "finish", "free-first-task-slot", "accepted");
    await state(native.flow.store, () => native.flow.store.queue.list(owner, child.id)[0].status === "running");
    await verifyFirstTask(native, child, "first-task-correction");
  }
);
