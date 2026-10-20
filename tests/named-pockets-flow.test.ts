import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { CodexStore } from "./simulators/codex-store";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { simulatorArgs } from "./simulators/launch";
import test from "node:test";

const execute = promisify(execFile);
const TIMEOUT_MS = 60_000;

/** Seed the simulator database after its private directory exists.
@param root - Isolated test directory.
@returns Native original parent ID.
*/
function seed(root: string) {
  const store = new CodexStore(path.join(root, "codex.sqlite"));
  const parent = store.create({ cwd: root });

  store.save();

  return parent.id;
}

/** Prepare one explicit native configuration response for each independent transport.
@param root - Isolated test directory.
*/
async function scenario(root: string) {
  await mkdir(path.join(root, "state"));
  await writeFile(
    path.join(root, "scenario.json"),
    JSON.stringify({
      turn: { hold: true },
      scripts: [
        {
          method: "config/read",
          result: {
            config: {
              sandbox_mode: "read-only",
              approval_policy: "never",
              model: "simulator-model",
              model_reasoning_effort: "high",
            },
            origins: {},
          },
        },
      ],
    })
  );
}

/** Run two independent host processes against the same persisted native and Pocket state.
@param environment - Explicit offline environment shared by these host processes.
@param ids - Stable catalog and receipt identities.
*/
async function phases(environment: NodeJS.ProcessEnv, ids: string[]) {
  for (const phase of ["initial", "recovered"]) {
    await execute(
      process.execPath,
      [
        "--import",
        path.resolve("node_modules/tsx/dist/loader.mjs"),
        "tests/fixtures/named-pockets-flow.ts",
        phase,
        ...ids,
      ],
      { env: environment, timeout: TIMEOUT_MS }
    );
  }
}

await test(
  "named parent runtimes survive a host restart without cross-delivery or replay",
  { timeout: TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-named-flow-"));
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const nativeParent = seed(root);
    const environment = {
      ...process.env,
      CODEX_THREAD_ID: nativeParent,
      CODEX_CWD: root,
      CODEX_BINARY: process.execPath,
      CODEX_SERVER_ARGS: JSON.stringify(simulatorArgs),
      CODEX_POCKET_STATE_DIR: path.join(root, "state"),
      POCKET_SIMULATOR_STATE: path.join(root, "codex.sqlite"),
      POCKET_SIMULATOR_SCENARIO: path.join(root, "scenario.json"),
    };

    try {
      await scenario(root);

      await phases(environment, ids);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
