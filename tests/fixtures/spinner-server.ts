import { type ChildProcess, spawn } from "node:child_process";
import { fixtureBuild, signalFixture } from "./next-server";
import { expect } from "@playwright/test";
import { once } from "node:events";
import path from "node:path";
import type { spinnerClient } from "./spinner-client";

const HTTP_OK = 200;
const START_TIMEOUT = 90_000;

export interface SpinnerServer {
  directory: string;
  project: string;
  host?: ChildProcess;
  main?: Awaited<ReturnType<typeof spinnerClient>>;
  output: string;
}

/**
Start the spinner's fake-protocol Next app and wait for its HTTP endpoint.
@param server - Mutable fixture state owned by the spinner workflow.
@param origin - Dedicated loopback origin used by its browser and API assertions.
*/
export async function startSpinnerServer(server: SpinnerServer, origin: string) {
  const build = server.project === process.cwd() ? await fixtureBuild("spinner") : {};

  server.output = "";
  server.host = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", server.project, "--hostname", "127.0.0.1", "--port", "3103"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...build,
        NODE_ENV: "development",
        CODEX_THREAD_ID: "spinner-fixture",
        CODEX_CWD: server.directory,
        CODEX_POCKET_STATE_DIR: server.directory,
        CODEX_BINARY: process.execPath,
        CODEX_SERVER_ARGS: JSON.stringify([path.resolve("tests/fixtures/spinner-harness.mjs")]),
        CODEX_ALLOWED_ORIGINS: origin,
        POCKET_CHILD_ID: "",
        POCKET_COMMAND_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );
  server.host.stdout?.on("data", (data) => {
    server.output += String(data);
  });
  server.host.stderr?.on("data", (data) => {
    server.output += String(data);
  });
  await expect
    .poll(
      async () => {
        if (server.host?.exitCode !== null) {
          throw new Error(server.output);
        }

        try {
          const response1 = await fetch(`${origin}/api/spinner`);

          return response1.status;
        } catch {
          return 0;
        }
      },
      { timeout: START_TIMEOUT, message: "isolated Next dev fixture starts" }
    )
    .toBe(HTTP_OK);
}

/**
Stop the spinner app and any remaining Next workers before a workflow restarts it.
@param server - Fixture whose owned child process must finish before returning.
*/
export async function stopSpinnerServer(server: SpinnerServer) {
  const host = server.host;

  if (host) {
    if (host.exitCode === null) {
      const closed = once(host, "exit");

      signalFixture(host, "SIGTERM");
      await closed;
    }

    signalFixture(host, "SIGKILL");
  }

  server.host = undefined;
}
