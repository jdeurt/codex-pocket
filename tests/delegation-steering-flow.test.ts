import { CAPACITY, TEST_TIMEOUT_MS, owner, tool } from "./fixtures/delegation-flow";
import {
  activeAssignment,
  assertResumed,
  assertUnknownRecovery,
  correction,
  fillCapacity,
  nativeFlow,
  restartUnknown,
  savedAssignment,
  transcript,
} from "./fixtures/delegation-native";
import assert from "node:assert/strict";
import { delegationCommandSchema } from "../src/server/delegation-data";
import test from "node:test";

await test(
  "native active reasoning and tool steering bypass eight slots, deduplicate retries and supersede only selected later work",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const native = await nativeFlow(t);
    const children = await fillCapacity(native);
    const first = children[0];
    const stale = delegationCommandSchema.parse(
      await tool(native.client, "side_pocket_send", {
        id: first.id,
        message: "obsolete task",
        idempotencyKey: "obsolete",
        mode: "queue",
      })
    );
    const later = delegationCommandSchema.parse(
      await tool(native.client, "side_pocket_send", {
        id: first.id,
        message: "unrelated task",
        idempotencyKey: "later",
        mode: "queue",
      })
    );
    const receipt = await correction(native, first, "correct tool work", "correction", "accepted", [stale.id]);
    const retry = delegationCommandSchema.parse(
      await tool(native.client, "side_pocket_send", {
        id: first.id,
        message: "correct tool work",
        idempotencyKey: "correction",
        supersedes: [stale.id],
      })
    );
    const history = await transcript(native, first);
    const commands = native.flow.store.queue.list(owner, first.id);
    const reasoning = await correction(native, children[1], "correct reasoning", "reasoning-correction", "accepted");
    const reasoningHistory = await transcript(native, children[1]);

    assert.equal(retry.id, receipt.id);
    assert.equal(retry.status, "accepted");
    assert.equal(retry.turnId, history[0].id);
    assert.notEqual(retry.turnId, commands[0].id, "native turn identity must not be guessed from the assignment ID");
    assert.equal(commands.find((command) => command.id === stale.id)?.status, "cancelled");
    assert.equal(commands.find((command) => command.id === later.id)?.status, "queued");
    assert.equal(history.length, 1, "steering stays in the same native turn");
    assert.deepEqual(
      history[0].items.map((item) => item.text),
      ["tool", "correct tool work"]
    );
    assert.equal(native.flow.store.list(owner).filter((child) => child.status === "running").length, CAPACITY);
    assert.equal(reasoning.status, "accepted");
    assert.equal(reasoningHistory.length, 1);
    await tool(native.client, "side_pocket_cancel", {
      id: first.id,
      commandIds: [later.id],
      reason: "Distinct task withdrawn",
    });
    await tool(native.client, "side_pocket_cancel", {
      id: first.id,
      commandIds: [later.id],
      reason: "Retry cancellation",
    });
    assert.equal(
      native.flow.store.queue.list(owner, first.id).find((command) => command.id === later.id)?.result,
      "Distinct task withdrawn"
    );
  }
);

await test(
  "idle steering resumes its saved session only when execution capacity becomes available",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const native = await nativeFlow(t);
    const idle = await savedAssignment(native);
    const sessionId = native.flow.store.get(owner, idle.id).sessionId;
    const children = await fillCapacity(native);
    const receipt = delegationCommandSchema.parse(
      await tool(native.client, "side_pocket_send", {
        id: idle.id,
        message: "continue saved work",
        idempotencyKey: "idle-correction",
      })
    );
    const before = await transcript(native, idle);

    assert.equal(receipt.status, "queued");
    assert.equal(receipt.mode, "steer");
    assert.equal(before.length, 1);
    await correction(native, children[0], "finish", "free-slot", "accepted");
    await native.worker.until((events) =>
      events.some(
        (event) => event.event === "started" && event.childId === idle.id && event.text === "ready:continue saved work"
      )
    );
    await assertResumed(native, idle, sessionId);
  }
);

await test(
  "native completion races distinguish rejected-not-sent resumption from accepted steering without duplicate turns",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const native = await nativeFlow(t);
    const rejected = await activeAssignment(native, "rejected-race", "tool");
    const race = await correction(native, rejected, "race", "rejected-race-correction", "completed");
    const rejectedHistory = await transcript(native, rejected);
    const accepted = await activeAssignment(native, "accepted-race");
    const receipt = await correction(native, accepted, "accepted-before-end", "accepted-race-correction", "accepted");
    const acceptedHistory = await transcript(native, accepted);

    assert.equal(race.status, "completed");
    assert.deepEqual(
      rejectedHistory.map((turn) => turn.items.map((item) => item.text)),
      [["tool"], ["race"]]
    );
    assert.equal(receipt.status, "accepted");
    assert.equal(acceptedHistory.length, 1);
    assert.equal(acceptedHistory[0].items.length, 2);
  }
);

await test(
  "unsupported native steering stays unsupported and lost acknowledgements survive restart without replay",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const native = await nativeFlow(t);
    const child = await activeAssignment(native, "unknown-recovery", "tool");
    const unsupported = await correction(native, child, "unsupported", "unsupported", "unsupported");
    const failed = await correction(native, child, "reject", "explicit-rejection", "failed");
    const before = await transcript(native, child);
    const uncertain = await correction(native, child, "disconnect", "lost-ack", "unknown");

    assert.equal(unsupported.status, "unsupported");
    assert.equal(failed.status, "failed");
    assert.equal(before[0].items.length, 1);
    await restartUnknown(native, child);
    await assertUnknownRecovery(native, child, uncertain);
  }
);
