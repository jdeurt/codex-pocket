import { CAPACITY, assignment, fixture, owner, state, tool } from "./delegation-flow";
import { type DelegationCommand, type SidePocket, delegationCommandSchema } from "../../src/state/delegation-data";
import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { turnSchema } from "../../src/lib/protocol";
import { z } from "zod";

export type NativeFlow = Awaited<ReturnType<typeof nativeFlow>>;

/**
Read the owned fake native transcript independently of Pocket delivery receipts.
@param native - Isolated worker, private store and MCP client.
@param child - Child whose saved native session has already started.
@returns Validated native turns persisted by the offline subprocess.
*/
export async function transcript(native: NativeFlow, child: SidePocket) {
  const saved = native.flow.store.get(owner, child.id);
  const filename = path.join(native.flow.directory, `steering-${saved.sessionId ?? "missing"}.json`);
  const text = await readFile(filename, "utf8");

  return z.array(turnSchema).parse(JSON.parse(text));
}

/**
Start the actual worker and MCP boundary with native execution redirected only to the offline replay.
@param t - Integration context owning all process and private-state cleanup.
@returns The private flow, native worker and parent MCP client.
*/
export async function nativeFlow(t: TestContext) {
  const flow = await fixture(t);
  const worker = await flow.peer("native");
  const client = await flow.mcp();

  return { flow, worker, client };
}

/**
Assign work and wait for the actual native output frame proving its reasoning or tool phase began.
@param native - Owned offline native flow.
@param key - Stable creation identity and display title.
@param body - Assignment body echoed by the native replay at readiness.
@returns Managed child after its native start frame has reached the worker.
*/
export async function activeAssignment(native: NativeFlow, key: string, body = "reasoning") {
  const child = await tool(native.client, "side_pocket_create", assignment(key, "codex", body));

  await native.worker.until((events) =>
    events.some((event) => event.event === "started" && event.childId === child.id && event.text === `ready:${body}`)
  );

  return child;
}

/**
Occupy all eight real worker slots with isolated fake native processes.
@param native - Owned offline flow whose capacity is being exercised.
@returns Children in native readiness order, including a foreground tool phase.
*/
export async function fillCapacity(native: NativeFlow) {
  const children: SidePocket[] = [];
  const indices = Array.from({ length: CAPACITY }, (_, index) => index);

  for (const index of indices) {
    const child = await activeAssignment(native, `native-${String(index)}`, index === 0 ? "tool" : "reasoning");

    children.push(child);
  }

  return children;
}

/**
Send through real MCP and await a specified durable native outcome without treating storage as acceptance.
@param native - Owned offline flow.
@param child - Managed current-task target.
@param message - Exact correction or deliberate native race/fault selector.
@param key - Stable message identity for durable retries.
@param status - Required actual outcome, never a relaxed intermediate receipt.
@param supersedes - Exact stale unsent assignments this operation replaces.
@returns Canonical receipt after the required transition.
*/
export async function correction(
  native: NativeFlow,
  child: SidePocket,
  message: string,
  key: string,
  status: DelegationCommand["status"],
  supersedes: string[] = []
) {
  const receipt = delegationCommandSchema.parse(
    await tool(native.client, "side_pocket_send", { id: child.id, message, idempotencyKey: key, supersedes })
  );

  await state(native.flow.store, () =>
    native.flow.store.queue
      .list(owner, child.id)
      .some((command) => command.id === receipt.id && command.status === status)
  );

  return delegationCommandSchema.parse(
    native.flow.store.queue.list(owner, child.id).find((command) => command.id === receipt.id)
  );
}

/**
Create an idle saved native session before exercising capacity-gated resumption.
@param native - Owned offline flow.
@returns Child whose initial turn has completed.
*/
export async function savedAssignment(native: NativeFlow) {
  const child = await activeAssignment(native, "saved-idle", "finish");

  await state(native.flow.store, () => native.flow.store.queue.list(owner, child.id)[0].status === "completed");

  return child;
}

/**
Verify saved identity and native turn count after capacity becomes available.
@param native - Owned offline flow.
@param child - Saved child receiving an idle correction.
@param sessionId - Original native identity retained before the capacity block.
*/
export async function assertResumed(native: NativeFlow, child: SidePocket, sessionId: string | null | undefined) {
  const history = await transcript(native, child);

  assert.equal(native.flow.store.get(owner, child.id).sessionId, sessionId);
  assert.equal(history.length, 2);
  assert.equal(native.flow.store.list(owner).filter((entry) => entry.status === "running").length, CAPACITY);
}

/**
Join the owned worker's confirmed exit before launching its replacement.
@param native - Offline worker whose model-free subprocesses are already settled.
*/
async function stopWorker(native: NativeFlow) {
  const exited = once(native.worker.child, "exit");

  native.worker.child.send({ method: "stop" });
  await exited;
}

/**
Restart only the private fake worker after uncertainty, preserving the native transcript without replay.
@param native - Owned offline flow.
@param child - Child with an unknown native attempt.
*/
export async function restartUnknown(native: NativeFlow, child: SidePocket) {
  await state(native.flow.store, () => native.flow.store.get(owner, child.id).status === "unknown");
  await stopWorker(native);
  await native.flow.peer("native");
}

/**
Retry the identical uncertain receipt after restart and verify no native input was replayed.
@param native - Owned offline flow with its recovered durable store.
@param child - Managed child retaining its uncertain saved session.
@param command - Original durable message identity, content and retry key.
*/
export async function assertUnknownRecovery(native: NativeFlow, child: SidePocket, command: DelegationCommand) {
  const retry = delegationCommandSchema.parse(
    await tool(native.client, "side_pocket_send", { id: child.id, message: command.body, idempotencyKey: command.key })
  );
  const history = await transcript(native, child);

  assert.equal(retry.status, "unknown");
  assert.equal(retry.id, command.id);
  assert.equal(history.length, 1);
  assert.deepEqual(
    history[0].items.map((item) => item.text),
    ["tool", command.body]
  );
  assert.equal(native.flow.store.get(owner, child.id).status, "unknown");
}
