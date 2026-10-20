import { type Data, object, string } from "../src/lib/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { ClaudeSimulator } from "./simulators/claude";
import { SimulatorClient } from "./simulators/client";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

/** Verify an archived collection is empty.
@param client - Initialized connection.
*/
async function assertEmptyList(client: SimulatorClient) {
  const response = await client.call("thread/list");

  assert.deepEqual(response.data, []);
}

/** Verify the parent's title is independent from its fork.
@param client - Initialized connection.
@param threadId - Parent identity.
*/
async function assertOriginalName(client: SimulatorClient, threadId: string) {
  const response = await client.call("thread/read", { threadId });

  assert.equal(object(response.thread).name, "Saved session");
}

/**
Read saved history and confirm forks do not mutate their parent.
@param client - Reconnected simulator.
@param threadId - Original thread.
*/
async function inspectRecovered(client: SimulatorClient, threadId: string) {
  const resumed = await client.call("thread/read", { threadId, includeTurns: true });
  const forked = await client.call("thread/fork", { threadId });
  const forkId = string(object(forked.thread).id);

  assert.equal(object(resumed.thread).model, "next-model");
  assert.match(JSON.stringify(resumed.thread), /Steered/);
  assert.match(JSON.stringify(resumed.thread), /interrupted/);
  await client.call("thread/name/set", { threadId: forkId, name: "Independent fork" });
  await assertOriginalName(client, threadId);
  await client.call("thread/delete", { threadId: forkId });
}

/**
Start, conditionally steer, interrupt and save one native-shaped session.
@param client - Initialized simulator connection.
@returns Persisted session identity.
*/
async function activeFlow(client: SimulatorClient) {
  const started = await client.call("thread/start", { cwd: "/simulator" });
  const threadId = string(object(started.thread).id);
  const turn = await client.call("turn/start", { threadId, input: [{ type: "text", text: "Original" }] });
  const turnId = string(object(turn.turn).id);

  await assert.rejects(client.call("turn/steer", { threadId, expectedTurnId: "stale", input: [] }), /does not match/);
  await client.call("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "Steered" }] });
  await client.call("thread/settings/update", { threadId, model: "next-model", effort: "low" });
  await client.call("turn/interrupt", { threadId, turnId });
  await client.call("thread/name/set", { threadId, name: "Saved session" });

  return threadId;
}

/**
Drive one complete bidirectional tool turn including a duplicate-delivery check.
@param client - Initialized simulator.
*/
async function toolFlow(client: SimulatorClient) {
  const started = await client.call("thread/start", {});
  const threadId = string(object(started.thread).id);
  const response = await client.call("turn/start", { threadId, input: [] });
  const request = client.messages.find((message) => message.method === "item/tool/call");

  assert.ok(request);
  assert.equal(
    client.messages.some((message) => message.method === "turn/completed"),
    false
  );
  await client.server.receive({ id: request.id, result: { success: true, contentItems: [] } });
  assert.equal(client.messages.filter((message) => message.method === "turn/completed").length, 1);
  await assert.rejects(
    client.server.receive({ id: request.id, result: { success: true, contentItems: [] } }),
    /duplicate/
  );
  assert.equal(object(response.turn).status, "inProgress");
}

/**
Recover durable state in a fresh connection, fork independent history, and archive without erasing it.
@param stateFile - Private simulator database.
@param threadId - Saved native-style identity.
*/
async function reconnectFlow(stateFile: string, threadId: string) {
  const fresh = new SimulatorClient({ stateFile });
  const initialized = fresh.initialize();

  await initialized;
  await fresh.call("thread/resume", { threadId });
  await inspectRecovered(fresh, threadId);
  await fresh.call("thread/archive", { threadId });
  await assertEmptyList(fresh);
  await fresh.call("thread/unarchive", { threadId });
  await fresh.call("thread/delete", { threadId });
  await assert.rejects(fresh.call("thread/read", { threadId }), /thread not found/);
}

/**
Check a terminal error travels through notifications and native history without duplicate receipts.
@param client - Initialized connection with a failure scenario.
*/
async function failedTurn(client: SimulatorClient) {
  const started = await client.call("thread/start", {});
  const threadId = string(object(started.thread).id);

  await client.call("turn/start", { threadId, input: [] });
  assert.equal(client.messages.filter((message) => message.method === "turn/completed").length, 1);
  assert.match(
    JSON.stringify(await client.call("thread/read", { threadId, includeTurns: true })),
    /Fixture upstream disconnected/
  );
}

/** Build native input with a caller-owned durable identity.
@param uuid - Message identity.
@returns Native streaming input.
*/
function userMessage(uuid: string) {
  return { type: "user", uuid, message: { role: "user", content: uuid }, parent_tool_use_id: null };
}

/** Read a native control response by its stable request identity.
@param messages - Observed native frames.
@param id - Control request identity.
@returns Native control response payload.
*/
function controlResponse(messages: Data[], id: string) {
  const envelope = messages.find((message) => object(message.response).request_id === id);

  return object(envelope?.response);
}

await test("Codex state survives reconnect with steering, interruption, independent forks and archive lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocket-simulator-store-"));
  const stateFile = path.join(root, "state.json");
  const client = new SimulatorClient({ stateFile, turn: { hold: true } });

  try {
    await client.initialize();
    await reconnectFlow(stateFile, await activeFlow(client));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("server tools wait for a schema-valid reply, reject duplicate receipts, then complete once", async () => {
  const client = new SimulatorClient({
    turn: {
      chunks: ["Tool answered"],
      requests: [{ method: "item/tool/call", params: { callId: "tool-call", tool: "fixture", arguments: {} } }],
    },
  });

  await client.initialize();
  await toolFlow(client);
});

await test("full-contract scenarios validate external API responses and fail explicitly on unsupported behavior", async () => {
  const client = new SimulatorClient({
    scripts: [{ method: "account/read", result: { account: null, requiresOpenaiAuth: true } }],
  });

  await client.initialize();
  assert.deepEqual(await client.call("account/read"), { account: null, requiresOpenaiAuth: true });
  await assert.rejects(client.call("account/logout", null), /SIMULATOR_UNIMPLEMENTED/);
  await assert.rejects(client.call("thread/start", { cwd: false }), /Contract violation/);
  assert.equal(client.server.store.threads.size, 0);
});

await test("Claude interruption retains queued input receipts and emits one terminal result per submitted turn", async () => {
  const messages: Data[] = [];
  const first = randomUUID();
  const second = randomUUID();
  const server = new ClaudeSimulator(
    (message) => {
      messages.push(message);
    },
    { hold: true }
  );

  server.receive({ type: "control_request", request_id: "initialize", request: { subtype: "initialize" } });
  server.receive(userMessage(first));
  server.receive(userMessage(second));
  server.receive({ type: "control_request", request_id: "interrupt-first", request: { subtype: "interrupt" } });
  assert.deepEqual(object(controlResponse(messages, "interrupt-first").response), { still_queued: [second] });
  await Promise.resolve();
  server.receive({ type: "control_request", request_id: "interrupt-second", request: { subtype: "interrupt" } });
  assert.equal(messages.filter((message) => message.type === "result").length, 2);
  assert.ok(messages.filter((message) => message.type === "result").every((message) => message.is_error === true));
  server.receive({
    type: "control_request",
    request_id: "unsupported",
    request: { subtype: "read_file", path: "/private" },
  });
  assert.match(String(controlResponse(messages, "unsupported").error), /SIMULATOR_UNIMPLEMENTED/);
});

await test("scripted native failure terminates a Codex turn once and preserves the error in saved history", async () => {
  const client = new SimulatorClient({ turn: { chunks: [], failure: "Fixture upstream disconnected" } });

  await client.initialize();
  await failedTurn(client);
});
