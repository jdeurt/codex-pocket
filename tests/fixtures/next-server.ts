import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";

/**
Create private Next build and type paths for one fixture server.
@param name - Fixed fixture name used to separate concurrent test servers.
@returns Environment settings for the generated build directory and TypeScript config.
*/
export async function fixtureBuild(
  name: "browser" | "agents" | "uploads" | "pockets" | "spinner" | "update-a" | "update-b"
) {
  const directory = path.resolve(".next/test-configs");
  const tsconfig = path.join(directory, `${name}.json`);
  const distDir = `.next/test-${name}`;
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

  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

/**
Run the real app with a fixture-owned build cache and forward its shutdown signals.
@param name - Fixture whose build directory must remain independent.
@param origin - Loopback URL selected by the matching Playwright project.
@param environment - Fake protocol and private state settings for this server.
*/
export async function runNextFixture(
  name: "browser" | "agents" | "uploads" | "pockets",
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
        CODEX_THREAD_ID: "",
        POCKET_CHILD_ID: "",
        POCKET_COMMAND_ID: "",
        ...environment,
      },
    }
  );
  const stop = () => {
    signalFixture(host, "SIGTERM");
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    await once(host, "exit");
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    signalFixture(host, "SIGKILL");
    await rm(build.POCKET_TEST_TSCONFIG, { force: true });
  }
}
