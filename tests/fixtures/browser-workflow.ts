import { t as captureResult } from "try";
import { test as base } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as poll } from "node:timers/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { assertExpectedRequests } from "./unexpected-request";

const PROBE_MS = 2000;
const STARTUP_MS = 120_000;
const SHUTDOWN_MS = 15_000;
const POLL_MS = 100;
const CLEANUP_RETRIES = 3;
const CLEANUP_RETRY_MS = 100;
const scripts: Record<string, string> = {
  pockets: "pockets-server.ts",
  agents: "agent-browser-server.ts",
  uploads: "uploads-server.ts",
  realtime: "realtime-server.ts",
};
const directories: Record<string, string> = {
  pockets: ".local/pockets-fixture",
  agents: ".local/agent-browser-replay",
  uploads: ".local/uploads-replay",
  realtime: ".local/realtime-fixture",
};

/** Reject an occupied fixture port before starting an owned server.
@param origin - Project's loopback application address.
*/
async function requireFreePort(origin: string) {
  const url = new URL(origin);
  const socket = createServer();

  socket.listen(Number(url.port), url.hostname);
  await once(socket, "listening");
  await new Promise<void>((resolve) =>
    socket.close(() => {
      resolve();
    })
  );
}

/** Probe the guarded application readiness route with a bounded network deadline.
@param origin - Owned server origin.
@returns Whether the application has a successful version response.
*/
async function isReady(origin: string) {
  const response = await captureResult(fetch, `${origin}/api/version`, { signal: AbortSignal.timeout(PROBE_MS) });

  return response.ok && response.value.ok;
}

/** Wait for successful application readiness and retain startup diagnostics on failure.
@param host - Owned fixture process.
@param origin - Project's loopback application origin.
@param output - Native server diagnostics collected by this worker.
*/
async function ready(host: ChildProcess, origin: string, output: string[]) {
  const deadline = Date.now() + STARTUP_MS;

  while (!(await isReady(origin))) {
    if (host.exitCode !== null || host.signalCode !== null || Date.now() > deadline) {
      throw new Error(`Workflow server did not become ready:\n${output.join("")}`);
    }

    await poll(POLL_MS);
  }
}

export const test = base.extend<object, { application: undefined }>({
  application: [
    async ({ playwright: _playwright }, use, info) => {
      const kind = String(info.project.metadata.fixture);
      const script = scripts[kind];
      const directory = directories[kind];
      const origin = info.project.use.baseURL;

      if (!script || !directory || !origin) {
        throw new Error(`Missing browser workflow fixture for ${info.project.name}`);
      }

      await requireFreePort(origin);
      const home = path.resolve(directory, "home");
      const output: string[] = [];
      const host = spawn(process.execPath, ["--import", "tsx", `tests/fixtures/${script}`], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          NODE_ENV: "test",
          CODEX_HOME: home,
          CLAUDE_CONFIG_DIR: path.join(home, "claude"),
          CODEX_BINARY: path.join(home, "absent-codex"),
          POCKET_CLAUDE_BINARY: path.join(home, "absent-claude"),
          POCKET_TEST_BUILD_NAME: info.project.name,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(host, "exit");

      host.stdout.on("data", (chunk: Buffer) => {
        output.push(chunk.toString());
      });
      host.stderr.on("data", (chunk: Buffer) => {
        output.push(chunk.toString());
      });

      const started = await captureResult(ready(host, origin, output));
      const executed = started.ok ? await captureResult(() => use(undefined)) : started;

      host.kill("SIGTERM");
      const deadline = setTimeout(() => host.kill("SIGKILL"), SHUTDOWN_MS);

      await exited;
      clearTimeout(deadline);
      await mkdir(info.project.outputDir, { recursive: true });
      const logName = `fixture-${info.project.name}-worker-${String(info.workerIndex)}.log`;

      await writeFile(path.join(info.project.outputDir, logName), output.join(""));

      const completed = await captureResult(assertExpectedRequests(path.join(directory, "state")));

      await rm(directory, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES, retryDelay: CLEANUP_RETRY_MS });

      if (!completed.ok) {
        throw completed.error;
      }

      assert.equal(host.exitCode, 0, `Workflow server failed (${String(host.signalCode)}):\n${output.join("")}`);

      if (!executed.ok) {
        throw executed.error;
      }
    },
    { scope: "worker", auto: true },
  ],
});
