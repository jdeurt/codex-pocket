import {
  CAPACITY,
  LAST_INDEX,
  type Peer,
  TEST_TIMEOUT_MS,
  THREE_MORE_STARTS,
  assignment,
  fixture,
  owner,
  state,
  tool,
} from "./fixtures/delegation-flow";
import { type SidePocket } from "../src/server/delegation-data";
import assert from "node:assert/strict";
import test from "node:test";

/**
Persists native simulator assignments serially so dispatch assertions observe durable queue order.
@param writer - Owned native writer process bound to the private fixture store.
@param assignments - Domain assignments in their intended commit order.
@returns Canonical persisted child records in the same order.
*/
async function queueAssignments(writer: Peer, assignments: ReturnType<typeof assignment>[]) {
  const children: SidePocket[] = [];

  for (const input of assignments) {
    const child = await writer.call("create", input);

    children.push(child);
  }

  return children;
}

await test(
  "startup drains persisted assignments in queue order, caps both harnesses at eight, and exit frees a slot immediately",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer } = await fixture(t);
    const writer = await peer("writer");
    const assignments = Array.from({ length: CAPACITY + 1 }, (_, index) =>
      assignment(
        `queued-${String(index)}`,
        index % 2 ? "claude" : "codex",
        index === 0 ? "hold-close" : `queued-${String(index)}`
      )
    );
    const children = await queueAssignments(writer, assignments);

    const worker = await peer();

    await worker.until(() => worker.starts().length === CAPACITY);
    assert.deepEqual(
      worker.starts().map((entry) => entry.childId),
      children.slice(0, CAPACITY).map((child) => child.id)
    );
    assert.equal(store.queue.list(owner, children[CAPACITY].id)[0].status, "queued");
    await worker.call("complete", { childId: children[0].id });
    await state(store, () => store.queue.list(owner, children[0].id)[0].status === "completed");
    await worker.call("barrier");
    assert.equal(worker.starts().length, CAPACITY, "slot remains occupied until harness process exit");
    await worker.call("releaseClose", { childId: children[0].id });
    await worker.until(() => worker.starts().length === CAPACITY + 1);
    assert.equal(worker.starts().at(LAST_INDEX)?.childId, children[CAPACITY].id);
    await worker.call("barrier");
    assert.equal(new Set(worker.starts().map((entry) => entry.id)).size, CAPACITY + 1);
  }
);

await test(
  "simultaneous stdio enqueue wakes dispatch, and older queued assignments precede old-child followups",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer, mcp } = await fixture(t);
    const worker = await peer();
    const client = await mcp();
    const children = await Promise.all(
      Array.from({ length: CAPACITY + 1 }, (_, index) =>
        tool(client, "side_pocket_create", assignment(`burst-${String(index)}`))
      )
    );

    const observed = await worker.until(() => worker.starts().length === CAPACITY);
    const starts = observed.filter((entry) => entry.event === "started");
    const queued = children.find((child) => starts.every((start) => start.childId !== child.id));

    const first = starts[0];

    assert.ok(queued);

    await tool(client, "side_pocket_send", {
      id: first.childId,
      message: "followup-one",
      mode: "queue",
      idempotencyKey: "followup-one",
    });
    await tool(client, "side_pocket_send", {
      id: first.childId,
      message: "followup-two",
      mode: "queue",
      idempotencyKey: "followup-two",
    });
    await worker.call("complete", { childId: first.childId });
    await worker.until(() => worker.starts().length === CAPACITY + 1);
    assert.equal(worker.starts()[CAPACITY].childId, queued.id);
    await worker.call("complete", { childId: starts[1].childId });
    await worker.until(() => worker.starts().length === CAPACITY + 2);
    assert.equal(worker.starts().at(LAST_INDEX)?.text, "followup-one");
    await worker.call("complete", { childId: first.childId });
    await worker.until(() => worker.starts().length === CAPACITY + THREE_MORE_STARTS);
    assert.equal(worker.starts().at(LAST_INDEX)?.text, "followup-two");
    assert.deepEqual(
      store.queue.list(owner, first.childId).map((command) => command.status),
      ["completed", "completed", "running"]
    );
  }
);

await test(
  "competing process claims enforce the shared eight-child cap without duplicate starts",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { store, peer } = await fixture(t);
    const first = await peer("writer");
    const second = await peer("writer");
    const assignments = Array.from({ length: CAPACITY + 1 }, (_, index) => assignment(`contended-${String(index)}`));
    const children = await queueAssignments(first, assignments);

    const claims = await Promise.all(
      children.flatMap((child) => [
        first.call("claim", { childId: child.id }),
        second.call("claim", { childId: child.id }),
      ])
    );
    const claimed = claims.filter((command) => command !== undefined);

    assert.equal(claimed.length, CAPACITY);
    assert.equal(new Set(claimed.map((command) => command.id)).size, CAPACITY);

    assert.equal(
      children.flatMap((child) => store.queue.list(owner, child.id)).filter((command) => command.status === "running")
        .length,
      CAPACITY
    );
  }
);
