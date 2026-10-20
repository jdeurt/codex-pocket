import { TEST_TIMEOUT_MS, assignment, fixture, owner, state, tool } from "./fixtures/delegation-flow";
import assert from "node:assert/strict";
import { delegationCommandSchema } from "../src/server/delegation-data";
import test from "node:test";

const IDLE_RESUME_START_COUNT = 3;

/**
Exercise the real Claude adapter's unsupported receipt through an active worker and MCP send.
@param flow - Private durable fixture with a simulated native execution lifetime.
@param worker - Owned fake host; Claude's real steering method never starts an SDK query.
@param client - Parent's real stdio MCP client.
@param childId - Managed Claude child under the recorded parent policy.
*/
async function verifyActiveAndLater(
  flow: Awaited<ReturnType<typeof fixture>>,
  worker: Awaited<ReturnType<typeof flow.peer>>,
  client: Awaited<ReturnType<typeof flow.mcp>>,
  childId: string
) {
  const unsupported = delegationCommandSchema.parse(
    await tool(client, "side_pocket_send", {
      id: childId,
      message: "current correction",
      idempotencyKey: "claude-steer",
    })
  );
  const later = delegationCommandSchema.parse(
    await tool(client, "side_pocket_send", {
      id: childId,
      message: "distinct later task",
      idempotencyKey: "claude-later",
      mode: "queue",
    })
  );

  await state(flow.store, () =>
    flow.store.queue
      .list(owner, childId)
      .some((command) => command.id === unsupported.id && command.status === "unsupported")
  );
  assert.equal(worker.starts().length, 1);
  assert.equal(later.status, "queued");
  await worker.call("complete", { childId });
  await worker.until(() => worker.starts().length === 2);
  assert.equal(worker.starts()[1].text, "distinct later task");
  await worker.call("complete", { childId });
  await state(flow.store, () => flow.store.get(owner, childId).status === "idle");
}

/**
Resume the same saved Claude identity under normal capacity without replaying its unsupported correction.
@param flow - Private durable fixture retaining the completed native session.
@param worker - Owned fake host observing new execution slots.
@param client - Parent's real MCP client.
@param childId - Idle saved Claude child.
*/
async function verifyIdle(
  flow: Awaited<ReturnType<typeof fixture>>,
  worker: Awaited<ReturnType<typeof flow.peer>>,
  client: Awaited<ReturnType<typeof flow.mcp>>,
  childId: string
) {
  const sessionId = flow.store.get(owner, childId).sessionId;
  const receipt = delegationCommandSchema.parse(
    await tool(client, "side_pocket_send", {
      id: childId,
      message: "continue saved task",
      idempotencyKey: "claude-idle",
    })
  );

  assert.equal(receipt.mode, "steer");
  await worker.until(() => worker.starts().length === IDLE_RESUME_START_COUNT);
  assert.equal(worker.starts()[2].text, "continue saved task");
  assert.equal(flow.store.get(owner, childId).sessionId, sessionId);
  assert.equal(
    flow.store.queue.list(owner, childId).find((command) => command.key === "claude-steer")?.status,
    "unsupported"
  );
}

await test(
  "Claude rejects active steering without queue fallback while explicit later work and saved idle delivery remain executable",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const flow = await fixture(t);
    const worker = await flow.peer();
    const client = await flow.mcp();
    const child = await tool(client, "side_pocket_create", assignment("claude-contract", "claude"));

    await worker.until(() => worker.starts().length === 1);
    await verifyActiveAndLater(flow, worker, client, child.id);
    await verifyIdle(flow, worker, client, child.id);
  }
);
