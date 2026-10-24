import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Bridge } from "../../src/server/bridge-session";
import assert from "node:assert/strict";
import { delegations } from "../../src/server/delegations";
import { object } from "../../src/lib/protocol";
import os from "node:os";
import path from "node:path";
import { sessionSettingsSchema } from "../../src/server/session-settings";
import test from "node:test";

/**
Check captured wire operations preserve permissions, identity and active work.
@param directory - Fixture's native wire log directory.
*/
async function assertNativeCalls(directory: string) {
  const text = await readFile(path.join(directory, "requests.jsonl"), "utf8");
  const rows = text
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
  const updates = rows.filter((row) => row.method === "thread/settings/update");

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params, { threadId: "settings-parent", model: "updated-model", effort: "low" });
  assert.equal(
    rows.some((row) => String(row.method).startsWith("turn/")),
    false
  );
}

/**
Verify live settings, native counters and reconnect persistence without advancing the turn.
@param bridge - Initial connection owner.
@param resumed - Fresh bridge for persistence verification.
@param directory - Native call journal directory.
*/
async function exerciseSettings(bridge: Bridge, resumed: Bridge, directory: string) {
  const EXPECTED_INPUT = 100;

  await bridge.ensureConnected();
  assert.equal(bridge.session.info().activeTurnId, "active");
  assert.equal(bridge.session.info().usage.reported?.total.inputTokens, EXPECTED_INPUT);
  assert.equal(bridge.session.info().usage.remainingContextTokens, null);
  assert.equal(sessionSettingsSchema.safeParse({ threadId: "another", model: "bad" }).success, false);
  await bridge.session.update({ model: "updated-model", effort: "low" });
  assert.equal(bridge.session.info().model, "updated-model");
  assert.equal(bridge.session.info().effort, "low");
  assert.equal(bridge.session.info().activeTurnId, "active");
  bridge.close();
  await resumed.ensureConnected();
  assert.equal(resumed.session.info().model, "updated-model");
  assert.equal(resumed.session.info().effort, "low");
  await assertNativeCalls(directory);
}

/**
Exercise live mutation, native readback and a fresh-process reconnect without sending a turn.
@param directory - Private fixture directory containing captured native calls and persisted settings.
*/
async function settingsFlow(directory: string) {
  const bridge = new Bridge();
  const resumed = new Bridge();

  await (async () => exerciseSettings(bridge, resumed, directory))().finally(() => {
    bridge.close();
    resumed.close();
  });
}

await test("parent controls reuse the live transport, retain active work and persist model/effort across reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-controls-"));
  const environment = {
    CODEX_THREAD_ID: "settings-parent",
    CODEX_CWD: directory,
    CODEX_BINARY: process.execPath,
    CODEX_SERVER_ARGS: JSON.stringify([
      "--import",
      path.resolve("node_modules/tsx/dist/loader.mjs"),
      path.resolve("tests/fixtures/session-controls-codex.ts"),
    ]),
    CODEX_POCKET_STATE_DIR: directory,
    CODEX_POCKET_LOG_DIR: path.join(directory, "logs"),
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));

  Object.assign(process.env, environment);

  await (async () => settingsFlow(directory))().finally(async () => {
    delegations().close();

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }

    await rm(directory, { recursive: true, force: true });
  });
});
