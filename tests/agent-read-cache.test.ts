import { codexOwner, ownedTurn } from "./fixtures/codex-owner";
import { AgentReadCache } from "../src/server/agent-read-cache";
import { type AgentRecord } from "../src/server/agent-sources";
import assert from "node:assert/strict";
import { inspectAdoption } from "../src/server/session-adoption";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

await test("cached attached history opens while refresh is held and never crosses native identities", async (t) => {
  const gate = Promise.withResolvers<undefined>();
  const blocked = Promise.withResolvers<undefined>();

  const state = { isHeld: false, didOpen: false };

  const fixture = await codexOwner(t, async () => {
    if (!state.isHeld) {
      return;
    }

    blocked.resolve(undefined);
    await gate.promise;
  });
  const { thread, turn } = await ownedTurn(fixture);
  const input = { threadId: thread.id, title: "External", idempotencyKey: "cached", socketPath: fixture.socketPath };
  const session = await inspectAdoption(fixture.config, input);
  const child = fixture.store.adoptions.adopt("parent", input, session);
  const record: AgentRecord = {
    owner: "parent",
    sessionId: thread.id,
    cwd: fixture.directory,
    pocket: child,
    agent: {
      id: child.id,
      parentId: "parent",
      name: child.title,
      source: "side-pocket",
      harness: "codex",
      status: "idle",
      preview: "",
    },
  };
  const cache = new AgentReadCache();

  const open = async () => {
    await cache.full(record);
    state.didOpen = true;
  };
  const checkHeld = async () => {
    const pending = open();

    try {
      await blocked.promise;
      await setImmediate();
      assert.ok(state.didOpen, "A held refresh must not block the saved transcript");
      assert.equal(record.agent.preview, "Original assignment");
    } finally {
      gate.resolve(undefined);
      await pending;
      await cache.full(record, true);
    }
  };
  const checkReplacement = async () => {
    const replacement: AgentRecord = {
      ...record,
      sessionId: "missing-native-session",
      turns: undefined,
      agent: { ...record.agent, preview: "" },
    };

    assert.equal(record.agent.preview, "Original owner result");
    assert.equal(record.agent.status, "completed");
    await cache.full(replacement);
    assert.equal(replacement.historyError, true);
    assert.deepEqual(replacement.turns, []);
    assert.equal(replacement.agent.preview, "");
    assert.equal(
      fixture.calls.some((call) => call.method === "thread/resume"),
      false
    );
  };

  await cache.warm(record);
  assert.equal(record.agent.preview, "Original assignment");
  fixture.turns.release(turn.id);
  record.pocket = { ...child, updatedAt: child.updatedAt + 1 };
  state.isHeld = true;
  await checkHeld();
  await checkReplacement();
});
