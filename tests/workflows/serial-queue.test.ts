import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { SerialQueue } from "../../src/runtime/serial-queue";

/** Reject queued work after an explicitly controlled gate.
@param gate - Completion gate owned by the test.
@param failure - Exact rejection to deliver to the caller.
@returns A rejection once the gate opens.
*/
async function rejectAfter(gate: Promise<undefined>, failure: unknown): Promise<never> {
  await gate;
  throw failure;
}

/** Throw before returning a promise to exercise invocation failure.
@param failure - Exact thrown value to deliver to the caller.
@returns Never returns normally.
*/
function failImmediately(failure: unknown): Promise<never> {
  throw failure;
}

/** Record when a queued operation starts.
@param events - Test-owned execution record.
@param value - Operation's result.
@returns The supplied result.
*/
function record(events: string[], value: string) {
  events.push(value);

  return Promise.resolve(value);
}

/**
Verify asynchronous rejection identity, execution order and independent caller results.
*/
async function preservesRejections() {
  const queue = new SerialQueue();
  const gate = Promise.withResolvers<undefined>();
  const failure = new Error("Queued operation failed");
  const events: string[] = [];
  const failed = queue.run(rejectAfter, gate.promise, failure);
  const outcomes = Promise.allSettled([failed]);
  const following = queue.run(record, events, "next");

  await Promise.resolve();
  assert.deepEqual(events, []);
  gate.resolve(undefined);
  const [outcome] = await outcomes;

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason, failure);
  assert.equal(await following, "next");
  assert.deepEqual(events, ["next"]);
}

/**
Verify synchronous and falsy failures also reject callers without blocking later work.
*/
async function preservesInvocationFailures() {
  for (const failure of [new Error("Invocation failed"), undefined, null, false]) {
    const queue = new SerialQueue();
    const failed = queue.run(failImmediately, failure);
    const outcomes = Promise.allSettled([failed]);
    const following = queue.run(record, [], "recovered");
    const [outcome] = await outcomes;

    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason, failure);
    assert.equal(await following, "recovered");
  }
}

await test("serial queue propagates the original rejection and preserves execution order", preservesRejections);
await test(
  "serial queue propagates synchronous and falsy failures without blocking later work",
  preservesInvocationFailures
);

/**
Verify queue bookkeeping does not hide a rejection when its caller forgets to handle it.
*/
function exposesUnhandledFailure() {
  const child = spawnSync(
    process.execPath,
    [
      "--import=tsx",
      "--input-type=module",
      "--unhandled-rejections=throw",
      "--eval",
      `
        import { setTimeout } from "node:timers/promises";
        import { SerialQueue } from "./src/runtime/serial-queue.ts";
        function fail() { return Promise.reject(new Error("Unhandled queued failure")); }
        const queue = new SerialQueue();
        void queue.run(fail);
        void queue.run(Promise.resolve.bind(Promise));
        await setTimeout(20);
      `,
    ],
    { encoding: "utf8", timeout: 10_000 }
  );

  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Unhandled queued failure/);
}

await test("serial queue does not hide an unhandled caller rejection", exposesUnhandledFailure);
