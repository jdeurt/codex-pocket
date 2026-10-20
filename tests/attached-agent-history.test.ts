import { type AgentRecord, hydrateAgent } from "../src/server/agent-sources";
import { codexOwner, ownedTurn } from "./fixtures/codex-owner";
import { AgentReadCache } from "../src/server/agent-read-cache";
import assert from "node:assert/strict";
import { inspectAdoption } from "../src/server/session-adoption";
import test from "node:test";

await test("adopted agent preview and transcript come from its live owner without a parent reader", async (t) => {
  const fixture = await codexOwner(t);
  const { thread, turn } = await ownedTurn(fixture);
  const input = { threadId: thread.id, title: "External", idempotencyKey: "external", socketPath: fixture.socketPath };
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

  await cache.warm(record);
  assert.equal(record.historyError, false);
  assert.equal(record.agent.preview, "Original assignment");
  assert.equal(record.agent.status, "running");
  fixture.turns.release(turn.id);
  await hydrateAgent(record);
  assert.equal(record.agent.preview, "Original owner result");
  assert.equal(record.agent.status, "completed");
  assert.equal(record.turns?.length, 1);
  assert.equal(
    fixture.calls.some((call) => call.method === "thread/resume"),
    false
  );
});
