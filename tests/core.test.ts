import { type PendingRequest, initialSnapshot, object } from "../src/lib/protocol";
import assert from "node:assert/strict";
import { configSchema } from "../src/server/config";
import { guard } from "../src/server/http";
import { reduceEvent } from "../src/server/reducer";
import test from "node:test";
import { validateAnswer } from "../src/server/answers";

function makeRequest(headers: Record<string, string>) {
  return new Request("http://localhost:3000/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

await test("environment configuration rejects remote origins with paths and relative cwd", () => {
  assert.throws(() => configSchema.parse({ threadId: "test", cwd: "relative" }));
  assert.throws(() => configSchema.parse({ threadId: "test", cwd: "/tmp", allowedOrigins: ["https://host/path"] }));
  assert.equal(configSchema.parse({ threadId: "test", cwd: "/tmp" }).activeMessageMode, "steer");
});

await test("a phone approval cannot silently grant a session-wide exception", () => {
  const request: PendingRequest = { id: "approval", method: "item/commandExecution/requestApproval", params: {} };

  assert.deepEqual(validateAnswer(request, { decision: "accept" }), { decision: "accept" });
  assert.throws(() => validateAnswer(request, { decision: "acceptForSession" }));
  assert.throws(() =>
    validateAnswer({ ...request, params: { availableDecisions: ["decline"] } }, { decision: "accept" })
  );
});

await test("permission answers grant only the requested profile for the current turn", () => {
  const permissions = { network: { enabled: true } };
  const request: PendingRequest = {
    id: "permission",
    method: "item/permissions/requestApproval",
    params: { permissions },
  };

  assert.deepEqual(validateAnswer(request, { allow: true }), { permissions, scope: "turn" });
  assert.deepEqual(validateAnswer(request, { allow: false }), { permissions: {}, scope: "turn" });
});

await test("questions require an answer for each question and reject unrelated answers", () => {
  const request: PendingRequest = {
    id: "question",
    method: "item/tool/requestUserInput",
    params: { questions: [{ id: "choice" }] },
  };

  assert.deepEqual(validateAnswer(request, { answers: { choice: { answers: ["A"] } } }), {
    answers: { choice: { answers: ["A"] } },
  });
  assert.throws(() => validateAnswer(request, { answers: {} }));
  assert.throws(() => validateAnswer(request, { answers: { other: { answers: ["A"] } } }));
});

await test("streaming messages stay isolated to their thread and stale completions do not stop a newer turn", () => {
  const state = {
    ...structuredClone(initialSnapshot),
    threadId: "thread",
    activeTurnId: "new",
    turns: [{ id: "old", status: "inProgress", items: [{ id: "reply", type: "agentMessage", text: "Hello" }] }],
  };

  reduceEvent(state, {
    method: "item/agentMessage/delta",
    params: { threadId: "other", turnId: "old", itemId: "reply", delta: "Wrong" },
  });
  reduceEvent(state, {
    method: "item/agentMessage/delta",
    params: { threadId: "thread", turnId: "old", itemId: "reply", delta: " world" },
  });
  reduceEvent(state, {
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "old", status: "completed", items: [] } },
  });
  assert.equal(object(state.turns[0].items[0]).text, "Hello world");
  assert.equal(state.activeTurnId, "new");
});

await test("mutation guard rejects cross-origin, missing-origin, and unknown-host requests", async () => {
  await assert.doesNotReject(guard(makeRequest({ host: "localhost:3000", origin: "http://localhost:3000" }), true));
  await assert.rejects(guard(makeRequest({ host: "localhost:3000", origin: "https://untrusted.example" }), true));
  await assert.rejects(guard(makeRequest({ host: "localhost:3000" }), true));
  await assert.rejects(guard(makeRequest({ host: "untrusted.example", origin: "http://localhost:3000" }), true));
});
