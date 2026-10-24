import { t as captureResult } from "try";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, open, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { signalFixture } from "./next-server";
import { assertExpectedRequests } from "./unexpected-request";

const ORIGIN = "http://127.0.0.1:3191";
const POLL_MS = 100;
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 1000;

/**
Probe startup without treating refused connections as fixture failures.
@returns The endpoint JSON when the host can answer.
*/
async function runningVersion(): Promise<unknown> {
  const response = await captureResult(fetch, `${ORIGIN}/api/version`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    return;
  }

  const body = await captureResult(() => response.value.json());

  return body.value;
}

/**
Own a production Next process and synthetic native state across a real host replacement.
*/
export class UpdateHost {
  private child?: ChildProcess;

  readonly directory = path.resolve(".local/update-browser");

  /**
  Wait for the real version route; a native Codex process is not needed for readiness.
  @param version - Expected compiled identity, independent of the startup environment.
  */
  private async ready(version: string) {
    const deadline = Date.now() + START_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const data = await runningVersion();

      if (JSON.stringify(data) === JSON.stringify({ version: `update-fixture-${version}` })) {
        return;
      }

      await setTimeout(POLL_MS);
    }

    throw new Error(`Production build ${version} did not become ready. See ${this.directory}.`);
  }

  /**
  Remove only this suite's synthetic history before a new browser scenario.
  */
  async reset() {
    await rm(this.directory, { recursive: true, force: true });
    await mkdir(this.directory, { recursive: true });
  }

  /**
  Launch precompiled assets on the same origin as the previous host, without rebuilding.
  @param version - Compiled release selected for this phase of the update.
  */
  async start(version: "a" | "b") {
    const output = await open(path.join(this.directory, `${version}.log`), "a");

    this.child = spawn(
      process.execPath,
      ["node_modules/next/dist/bin/next", "start", "-p", "3191", "-H", "127.0.0.1"],
      {
        detached: true,
        stdio: ["ignore", output.fd, output.fd],
        env: {
          ...process.env,
          NODE_ENV: "production",
          POCKET_TEST_DIST_DIR: `.next/test-update-${version}`,
          POCKET_TEST_TSCONFIG: `.next/test-configs/update-${version}.json`,
          // Deliberately differ from compilation to catch runtime/client identity mismatches.
          POCKET_BUILD_VERSION: "runtime-must-not-replace-compiled-version",
          CODEX_THREAD_ID: "upload-replay-parent",
          POCKET_TEST_MAIN_HARNESS: "codex",
          CODEX_CWD: process.cwd(),
          CODEX_BINARY: process.execPath,
          CODEX_SERVER_ARGS: JSON.stringify(["--import", "tsx", path.resolve("tests/fixtures/uploads-rpc.ts")]),
          CODEX_ALLOWED_ORIGINS: ORIGIN,
          CODEX_POCKET_STATE_DIR: path.join(this.directory, "state"),
          CLAUDE_CONFIG_DIR: path.join(this.directory, "claude"),
          POCKET_UPLOAD_REPLAY: this.directory,
        },
      }
    );
    await output.close();
    await this.ready(version);
  }

  /**
  Terminate only the owned Next process group, closing its existing event streams.
  */
  async stop() {
    const child = this.child;
    const exited = child?.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined;

    if (child && exited) {
      signalFixture(child, "SIGKILL");
      await exited;
    }

    await assertExpectedRequests(path.join(this.directory, "state"));
  }
}
