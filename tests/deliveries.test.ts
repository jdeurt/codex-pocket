import { type QueuedMessage, type Snapshot, initialSnapshot } from "../src/lib/protocol";
import assert from "node:assert/strict";
import { reconcileDeliveries } from "../src/lib/deliveries";
import test from "node:test";

await test("a send stays visible before acknowledgment and merges with the server queue by ID", () => {
  const pending: QueuedMessage[] = [{ id: "first", text: "Hello", status: "sending" }];
  assert.deepEqual(reconcileDeliveries(initialSnapshot, pending).state.queue, pending);
  const queued: Snapshot = { ...initialSnapshot, queue: [{ ...pending[0], status: "queued" }] };
  assert.deepEqual(reconcileDeliveries(queued, pending).state.queue, queued.queue);
  const acknowledged: QueuedMessage[] = [{ ...pending[0], status: "sent" }];
  assert.deepEqual(reconcileDeliveries(queued, acknowledged).state.queue, acknowledged);
});

await test("Codex confirmation removes only the matching optimistic message even when text is identical", () => {
  const first: QueuedMessage = { id: "first", text: "Hello", status: "sending" };
  const second: QueuedMessage = { ...first, id: "second" };
  const state: Snapshot = {
    ...initialSnapshot,
    queue: [first, second],
    turns: [{ id: "turn", status: "inProgress", items: [{ id: "item", type: "userMessage", clientId: "first" }] }],
  };
  const result = reconcileDeliveries(state, [first, second]);
  assert.deepEqual(result.pending, [second]);
  assert.deepEqual(result.state.queue, [second]);
  assert.deepEqual(reconcileDeliveries(state, [{ ...first, status: "sent" }, second]), result);
});

await test("uncertain sends remain visible across a disconnected snapshot", () => {
  const pending: QueuedMessage[] = [{ id: "first", text: "Hello", status: "unknown" }];
  const result = reconcileDeliveries({ ...initialSnapshot, connection: "disconnected" }, pending);
  assert.deepEqual(result.state.queue, pending);
  assert.deepEqual(result.pending, pending);
});
