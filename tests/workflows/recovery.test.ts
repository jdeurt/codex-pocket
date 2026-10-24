import { type Data, type Turn } from "../../src/lib/protocol";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Bridge } from "../../src/server/bridge-session";
import { CodexStore } from "../simulators/codex-store";
import assert from "node:assert/strict";
import { configSchema } from "../../src/server/config";
import os from "node:os";
import path from "node:path";
import { simulatorArgs } from "../simulators/launch";
import test from "node:test";

const TURN_ID = "retrying-turn";
const ITEM_ID = "resumed-assistant";
const MODEL_PAGE = { data: [], nextCursor: null };
const TIMEOUT_MS = 30_000;

/**
Build one native protocol scenario for retry, scoped progress and persistent failure.
@param threadId - Actual saved simulator parent hydrated by the production bridge.
@returns Sequential scripted calls validated against the native notification contract.
*/
function scenario(threadId: string) {
  const turn: Turn = { id: TURN_ID, status: "inProgress", items: [], error: null };
  const event = (method: string, params: Data) => ({ method, params: { threadId, turnId: TURN_ID, ...params } });
  const retry = event("error", { error: { message: "Reconnecting 5/5" }, willRetry: true });
  const progress = event("item/agentMessage/delta", { itemId: ITEM_ID, delta: "Connection recovered" });

  return {
    scripts: [
      {
        method: "config/read",
        result: { config: { sandbox_mode: "read-only", approval_policy: "never" }, origins: {} },
      },
      {
        method: "turn/start",
        result: { turn },
        before: [
          event("turn/started", { turn }),
          event("item/started", {
            startedAtMs: Date.now(),
            item: { id: ITEM_ID, type: "agentMessage", text: "", phase: "final_answer" },
          }),
        ],
      },
      { method: "model/list", result: MODEL_PAGE, before: [retry] },
      {
        method: "model/list",
        result: MODEL_PAGE,
        before: [{ ...progress, params: { ...progress.params, threadId: "foreign-parent" } }],
      },
      { method: "model/list", result: MODEL_PAGE, before: [progress] },
      {
        method: "model/list",
        result: MODEL_PAGE,
        before: [event("error", { error: { message: "Persistent provider failure" }, willRetry: false })],
      },
      { method: "model/list", result: MODEL_PAGE, before: [progress] },
      { method: "model/list", result: MODEL_PAGE, before: [retry] },
    ],
  };
}

/**
Exercise real native delivery, scoped recovery and fatal-error persistence on the hydrated bridge.
@param bridge - Production parent backed exclusively by the protocol simulator.
*/
async function verifyRecovery(bridge: Bridge) {
  await bridge.ensureConnected();
  await bridge.send("recovery-task", "Continue this task after a recoverable provider interruption");

  const rpc = bridge.agentReader();

  await rpc.request("model/list");
  assert.deepEqual(bridge.snapshot.connectionRetry, { turnId: TURN_ID, message: "Reconnecting 5/5" });
  assert.equal(bridge.snapshot.error, undefined);
  await rpc.request("model/list");
  assert.equal(bridge.snapshot.connectionRetry.message, "Reconnecting 5/5");
  await rpc.request("model/list");
  assert.equal(bridge.snapshot.connectionRetry, undefined);
  assert.equal(bridge.snapshot.activeTurnId, TURN_ID);
  assert.equal(bridge.snapshot.turns[0].items[0].text, "Connection recovered");
  await rpc.request("model/list");
  await rpc.request("model/list");
  assert.equal(bridge.snapshot.error, "Persistent provider failure");
  await rpc.request("model/list");
  assert.deepEqual(bridge.snapshot.connectionRetry, { turnId: TURN_ID, message: "Reconnecting 5/5" });
  await rpc.shutdown();
  await bridge.ensureConnected();
  assert.equal(bridge.snapshot.connection, "connected");
  assert.equal(bridge.snapshot.connectionRetry, undefined);
}

await test(
  "native retry notice clears on scoped resumed assistant output while fatal errors persist",
  { timeout: TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-transcript-recovery-"));
    const stateFile = path.join(root, "native.json");
    const scenarioFile = path.join(root, "scenario.json");
    const native = new CodexStore(stateFile);
    const thread = native.create({ cwd: root });
    const environment = {
      CODEX_POCKET_STATE_DIR: path.join(root, "state"),
      POCKET_SIMULATOR_STATE: stateFile,
      POCKET_SIMULATOR_SCENARIO: scenarioFile,
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    const bridge = new Bridge(
      configSchema.parse({
        threadId: thread.id,
        cwd: root,
        codexBinary: process.execPath,
        serverArgs: simulatorArgs,
      })
    );

    native.save();
    Object.assign(process.env, environment);
    await writeFile(scenarioFile, JSON.stringify(scenario(thread.id)));

    await (async () => verifyRecovery(bridge))().finally(async () => {
      bridge.close();

      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }

      await rm(root, { recursive: true, force: true });
    });
  }
);
