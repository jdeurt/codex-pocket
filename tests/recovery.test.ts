import { RECOVERY_PROMPT, isRecoveryMessageId, recoveryReceipt } from "../src/server/recovery";
import { type Snapshot, initialSnapshot, snapshotSchema } from "../src/lib/protocol";
import { type Receipt } from "../src/server/outbox";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const turns = [{ id: "turn", status: "completed", items: [{ id: "user", type: "userMessage" }] }];

/**
Require a new durable recovery identity after the previous prompt was sent.
@param first - Verified initial recovery receipt.
*/
function assertSentRecovery(first: Receipt) {
  const next = recoveryReceipt(turns, [{ ...first, status: "sent" }]);

  assert.ok(next);
  assert.notEqual(first.id, next.id);
  assert.equal(isRecoveryMessageId(crypto.randomUUID()), false);
}

/**
Require one queued recovery and reject duplicates in every pending delivery state.
*/
function assertRecoveryReplacement() {
  const first = recoveryReceipt(turns, []);

  assert.ok(first);
  assert.equal(isRecoveryMessageId(first.id), true);
  assert.equal(first.status, "queued");

  for (const status of ["queued", "sending", "unknown"] as const) {
    assert.equal(recoveryReceipt(turns, [{ ...first, status }]), undefined);
  }

  assertSentRecovery(first);
}

/**
Require the actual generated recovery receipt before constructing the persisted history fixture.
@returns Verified native recovery receipt.
*/
function requiredRecovery() {
  const recovery = recoveryReceipt(turns, []);

  assert.ok(recovery);

  return recovery;
}

/**
Round-trip durable JSON and require the same public projection without mutating the source queue.
@param state - Native snapshot containing hidden recovery and ordinary messages.
@param visible - Public projection before serialization.
*/
function assertSavedRecovery(state: Snapshot, visible: Snapshot) {
  const saved = JSON.stringify(state);
  const restored = snapshotSchema.parse(JSON.parse(saved));

  assert.deepEqual(visibleSnapshot(restored), visible);
}

await test("only resumed history produces recovery, and an existing pending or uncertain recovery is not duplicated", () => {
  assert.equal(recoveryReceipt([], []), undefined);
  assert.equal(recoveryReceipt([{ id: "empty", status: "completed", items: [] }], []), undefined);
  assertRecoveryReplacement();
});

await test("recovery prompts stay hidden by durable identity while ordinary messages and agent responses remain", () => {
  const recovery = requiredRecovery();
  const ordinary: Receipt = { id: crypto.randomUUID(), text: RECOVERY_PROMPT, status: "queued" };
  const state: Snapshot = {
    ...structuredClone(initialSnapshot),
    queue: [recovery, ordinary],
    turns: [
      {
        id: "turn",
        status: "completed",
        items: [
          {
            id: "hidden",
            type: "userMessage",
            clientId: recovery.id,
            content: [{ type: "text", text: recovery.text }],
          },
          {
            id: "visible",
            type: "userMessage",
            clientId: ordinary.id,
            content: [{ type: "text", text: ordinary.text }],
          },
          { id: "progress", type: "agentMessage", phase: "commentary", text: "Checking expected jobs" },
          { id: "final", type: "agentMessage", phase: "final_answer", text: "Nothing remains open" },
        ],
      },
    ],
  };
  const visible = visibleSnapshot(state);

  assert.deepEqual(visible.queue, [ordinary]);
  assert.deepEqual(visible.turns[0].items, state.turns[0].items.slice(1));
  assertSavedRecovery(state, visible);
  assert.equal(state.queue.length, 2);
});
