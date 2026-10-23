import { mkdtemp, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const flowHome = await mkdtemp(path.join(os.tmpdir(), "pocket-offline-home-"));
const names = await readdir(path.join(root, "tests"));
const args = process.argv.slice(2);
const selected = args.filter((argument) => argument.startsWith("tests/") && argument.endsWith(".test.ts"));
const tests = names.filter(
  (name) =>
    name.endsWith(".test.ts") &&
    (!args.includes("--simulators") || name === "simulator-flow.test.ts") &&
    (selected.length === 0 || selected.includes(`tests/${name}`))
);
const forwarded = args.filter((argument) => argument !== "--simulators" && !selected.includes(argument));

if (tests.length === 0 || selected.some((file) => !tests.includes(path.basename(file)))) {
  await rm(flowHome, { recursive: true, force: true });
  throw new Error("Select existing integration test files under tests/.");
}

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
      HOME: flowHome,
      USERPROFILE: flowHome,
      CODEX_HOME: flowHome,
      CLAUDE_CONFIG_DIR: flowHome,
      CODEX_BINARY: path.join(flowHome, "absent-codex"),
      POCKET_CLAUDE_BINARY: path.join(flowHome, "absent-claude"),
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
  await rm(flowHome, { recursive: true, force: true });
}
