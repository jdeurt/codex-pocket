import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { t as attempt } from "try";

const NEXT_SHUTDOWN_MS = 5000;

/**
Create private Next build and type paths for one fixture server.
@param name - Fixed fixture name used to separate concurrent test servers.
@returns Environment settings for the generated build directory and TypeScript config.
*/
export async function fixtureBuild(
  name: "browser" | "agents" | "uploads" | "pockets" | "spinner" | "update-a" | "update-b" | "realtime"
) {
  const buildName = process.env.POCKET_TEST_BUILD_NAME ?? name;

  if (!/^[a-z0-9-]+$/.test(buildName)) {
    throw new Error("Invalid fixture build name.");
  }

  const directory = path.resolve(".next/test-configs");
  const tsconfig = path.join(directory, `${buildName}.json`);
  const distDir = `.next/test-${buildName}`;
  const source = {
    extends: path.relative(directory, path.resolve("tsconfig.json")),
    include: [
      path.resolve("next-env.d.ts"),
      path.resolve("src/**/*.ts"),
      path.resolve("src/**/*.tsx"),
      path.resolve(`${distDir}/types/**/*.ts`),
      path.resolve(`${distDir}/dev/types/**/*.ts`),
    ],
  };

  await mkdir(directory, { recursive: true });
  await writeFile(tsconfig, JSON.stringify(source));

  return { POCKET_TEST_DIST_DIR: distDir, POCKET_TEST_TSCONFIG: path.relative(process.cwd(), tsconfig) };
}

/**
Signal only the process group created for this fixture's Next CLI and workers.
@param host - The detached child whose descendants share its process group.
@param signal - Shutdown signal to forward to that owned group.
*/
export function signalFixture(host: ChildProcess, signal: NodeJS.Signals): void {
  const processId = host.pid;

  if (processId === undefined) {
    return;
  }

  const outcome = attempt(() => {
    process.kill(-processId, signal);
  });

  if (outcome.ok) {
    return;
  }

  const error = outcome.error;

  if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
    throw error;
  }
}

/**
Run the real app with a fixture-owned build cache and forward its shutdown signals.
@param name - Fixture whose build directory must remain independent.
@param origin - Loopback URL selected by the matching Playwright project.
@param environment - Fake protocol and private state settings for this server.
*/
export async function runNextFixture(
  name: "browser" | "agents" | "uploads" | "pockets" | "realtime",
  origin: string,
  environment: Record<string, string>
): Promise<void> {
  const build = await fixtureBuild(name);
  const port = new URL(origin).port;
  const host = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", port],
    {
      stdio: "inherit",
      detached: true,
      env: {
        ...process.env,
        ...build,
        NODE_ENV: "development",
        POCKET_TEST_MAIN_HARNESS: "codex",
        CODEX_THREAD_ID: "",
        POCKET_CHILD_ID: "",
        POCKET_COMMAND_ID: "",
        ...environment,
      },
    }
  );
  const resources: { shutdown?: NodeJS.Timeout } = {};
  const stop = () => {
    if (resources.shutdown) {
      return;
    }

    signalFixture(host, "SIGTERM");
    resources.shutdown = setTimeout(() => {
      signalFixture(host, "SIGKILL");
    }, NEXT_SHUTDOWN_MS);
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  await (async () => once(host, "exit"))().finally(async () => {
    clearTimeout(resources.shutdown);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    signalFixture(host, "SIGKILL");
    await rm(build.POCKET_TEST_TSCONFIG, { force: true });
  });
}
