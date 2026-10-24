import { t as captureResult } from "try";
import { type Config, readConfig } from "../src/server/config";
import { CodexRpc } from "../src/server/rpc";
import { DelegationCheck } from "./delegation-check-session";
import { mkdir } from "node:fs/promises";
import nextEnv from "@next/env";
import path from "node:path";

/**
Creates and names the real native parent thread on the connected bootstrap transport.
@param setup - Owned bare native bootstrap connection.
@param cwd - Fresh private working folder.
@returns Newly created native parent identity.
*/
async function createParent(setup: CodexRpc, cwd: string) {
  const { thread } = await setup.request("thread/start", {
    cwd,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    ephemeral: false,
  });

  await setup.request("thread/name/set", { threadId: thread.id, name: "Pocket delegation integration check" });

  return thread.id;
}

/**
Owns the native bootstrap process until the new parent thread is ready.
@param base - Existing validated native configuration.
@param cwd - Fresh private working folder.
@returns Newly created parent identity after confirmed bootstrap process exit.
*/
async function bootstrap(base: Config, cwd: string) {
  const setup = new CodexRpc();

  const started = await captureResult(setup.connect({ ...base, cwd }, "bare"));
  const executed = started.ok ? await captureResult(() => createParent(setup, cwd)) : started;

  await setup.shutdown();

  if (!executed.ok) {
    throw executed.error;
  }

  return executed.value;
}

/**
Installs the new parent's environment before constructing its bridge and delegation worker.
@param base - Existing validated native configuration.
@param root - Fresh private integration state root.
@param cwd - Fresh private native working folder.
@returns Completion of the explicitly requested real delegation check.
*/
async function configuredParent(base: Config, root: string, cwd: string) {
  const threadId = await bootstrap(base, cwd);

  process.env.CODEX_THREAD_ID = threadId;
  process.env.CODEX_CWD = cwd;
  await new DelegationCheck({ ...base, threadId, cwd }, root).run();
}

/**
Creates isolated state before starting any real parent or child native process.
@param base - Existing validated native configuration.
@returns Completion of private setup and the real delegation check.
*/
async function privateProject(base: Config) {
  const root = path.resolve(".local", "delegation-check", crypto.randomUUID());
  const cwd = path.join(root, "project");

  await mkdir(cwd, { recursive: true });
  process.env.CODEX_POCKET_STATE_DIR = path.join(root, "state");
  await configuredParent(base, root, cwd);
}

/**
Requires explicit existing Pocket configuration before the live check can construct native resources.
@returns Completion of the requested real delegation check; missing configuration rejects.
*/
async function main() {
  const base = await readConfig();

  if (!base) {
    throw new Error("Configure Pocket before running the real delegation check.");
  }

  await privateProject(base);
}

nextEnv.loadEnvConfig(process.cwd());
await main();
