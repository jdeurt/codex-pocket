import { mkdtemp, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const simulatorHome = await mkdtemp(path.join(os.tmpdir(), "pocket-offline-home-"));
const names = await readdir(path.join(root, "tests"));
const tests = names.filter(
  (name) => (process.argv.includes("--all") || name.startsWith("simulator")) && name.endsWith(".test.ts")
);
const forwarded = process.argv.slice(2).filter((argument) => argument !== "--all");
const child = spawn(
  process.execPath,
  [
    "--import",
    path.join(root, "node_modules/tsx/dist/loader.mjs"),
    "--test",
    ...forwarded,
    ...tests.map((name) => `tests/${name}`),
  ],
  {
    cwd: root,
    env: {
      NODE_ENV: "test",
      PATH: "",
      HOME: simulatorHome,
      USERPROFILE: simulatorHome,
      CODEX_HOME: simulatorHome,
      CLAUDE_CONFIG_DIR: simulatorHome,
      CODEX_BINARY: path.join(simulatorHome, "absent-codex"),
      POCKET_CLAUDE_BINARY: path.join(simulatorHome, "absent-claude"),
    },
    stdio: "inherit",
  }
);

/** Wait for the isolated test process without trusting an untyped event tuple.
@returns Its native exit code, or failure when terminated by a signal.
*/
function completion(): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

try {
  process.exitCode = await completion();
} finally {
  await rm(simulatorHome, { recursive: true, force: true });
}
