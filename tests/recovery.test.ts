import { RECOVERY_PROMPT, isRecoveryMessageId, recoveryReceipt } from "../src/server/recovery";
import { type Snapshot, initialSnapshot } from "../src/lib/protocol";
import type { Receipt } from "../src/server/outbox";
import assert from "node:assert/strict";
import test from "node:test";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const turns = [{ id: "turn", status: "completed", items: [{ id: "user", type: "userMessage" }] }];

test("only resumed history produces recovery, and an existing pending or uncertain recovery is not duplicated", () => {
  assert.equal(recoveryReceipt([], []), undefined);
  assert.equal(recoveryReceipt([{ id: "empty", status: "completed", items: [] }], []), undefined);
  const first = recoveryReceipt(turns, []);
  assert.ok(first);
  assert.equal(isRecoveryMessageId(first.id), true);
  assert.equal(first.status, "queued");

  for (const status of ["queued", "sending", "unknown"] as const) {
    assert.equal(recoveryReceipt(turns, [{ ...first, status }]), undefined);
  }

  const next = recoveryReceipt(turns, [{ ...first, status: "sent" }]);
  assert.ok(next);
  assert.notEqual(first.id, next.id);
  assert.equal(isRecoveryMessageId(crypto.randomUUID()), false);
});

test("recovery prompts stay hidden by durable identity while ordinary messages and agent responses remain", () => {
  const recovery = recoveryReceipt(turns, []) as Receipt;
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
  const saved = JSON.stringify(state);
  assert.deepEqual(visibleSnapshot(JSON.parse(saved)), visible);
  assert.equal(state.queue.length, 2);
});
