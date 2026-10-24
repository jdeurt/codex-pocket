import { t as captureResult } from "try";
import { saveSetupEnvironment } from "../../scripts/setup-env";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parseEnv, promisify } from "node:util";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { assertExpectedRequests } from "../fixtures/unexpected-request";

const runProcess = promisify(execFile);
const setupTimeoutMs = 10_000;

/**
Writes an existing installation that connects only to the offline restart replay.
@param directory - Private setup, history and log directory.
@returns Saved settings that the real setup subprocess must retain.
*/
async function savedReplaySettings(directory: string) {
  const values = {
    CODEX_THREAD_ID: "saved-setup-thread",
    CODEX_CWD: directory,
    CODEX_BINARY: process.execPath,
    CODEX_SERVER_ARGS: JSON.stringify([
      "--import",
      path.resolve("node_modules/tsx/dist/loader.mjs"),
      path.resolve("tests/fixtures/restart-rpc.ts"),
    ]),
    CODEX_ACTIVE_MESSAGE_MODE: "steer",
    CODEX_ALLOWED_ORIGINS: "http://127.0.0.1:9999",
    POCKET_PORT: "9999",
  };

  await writeFile(path.join(directory, "fake-history.json"), "[]");
  await saveSetupEnvironment(path.join(directory, ".env.local"), values);

  return values;
}

/**
Runs the actual setup entry point with a service-inherited Next environment marker.
@param directory - Private existing installation used by the fake native process.
@returns Completion of saved identity, native options and history verification.
*/
async function verifyServiceSetup(directory: string) {
  const values = await savedReplaySettings(directory);
  const result = await runProcess(
    process.execPath,
    ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), path.resolve("scripts/configure.ts")],
    {
      cwd: directory,
      timeout: setupTimeoutMs,
      env: {
        ...process.env,
        NODE_ENV: "production",
        __NEXT_PROCESSED_ENV: "true",
        CODEX_THREAD_ID: "injected-agent-thread",
        CODEX_BINARY: process.execPath,
        CODEX_CWD: undefined,
        CODEX_SERVER_ARGS: undefined,
        CODEX_ALLOWED_ORIGINS: undefined,
        CODEX_ACTIVE_MESSAGE_MODE: undefined,
        CODEX_POCKET_STATE_DIR: directory,
        CODEX_POCKET_LOG_DIR: path.join(directory, "logs"),
        POCKET_THREAD_ID: undefined,
        POCKET_ORIGIN: undefined,
        POCKET_PORT: undefined,
      },
    }
  );
  const saved = parseEnv(await readFile(path.join(directory, ".env.local"), "utf8"));

  await assertExpectedRequests(directory);
  assert.ok(result.stdout.includes("Reused thread saved-setup-thread."));
  assert.deepEqual(saved, values);
  assert.equal(await readFile(path.join(directory, "fake-history.json"), "utf8"), "[]");
}

await test("setup from a running service retains the saved chat and native settings without sending a turn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-service-setup-"));

  const completed = await captureResult(verifyServiceSetup(directory));

  await rm(directory, { recursive: true, force: true });

  if (!completed.ok) {
    throw completed.error;
  }
});
