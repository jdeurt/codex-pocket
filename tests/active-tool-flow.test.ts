import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { codexActivityFlow } from "./fixtures/codex-activity-flow";
import { claudeActivityFlow } from "./fixtures/claude-activity-flow";
import { piActivityFlow } from "./fixtures/pi-activity-flow";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TIMEOUT_MS = 30_000;

for (const [name, flow] of [
  ["Pi active tool execution survives parallel failure, sequential work, cancellation and restoration", piActivityFlow],
  ["Codex active tool execution survives thinking, out-of-order completion, errors and reconnect", codexActivityFlow],
  ["Claude active tool execution survives overlapping calls, results, failure and reconciliation", claudeActivityFlow],
] as const) {
  await test(name, { timeout: TIMEOUT_MS }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-active-tools-"));
    const environment = {
      CODEX_POCKET_STATE_DIR: root,
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      POCKET_SIMULATOR_STATE: path.join(root, "native.sqlite"),
      POCKET_SIMULATOR_SCENARIO: path.join(root, "scenario.json"),
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));

    Object.assign(process.env, environment);

    await writeFile(
      environment.POCKET_SIMULATOR_SCENARIO,
      JSON.stringify({
        scripts: Array.from({ length: 2 }, () => ({
          method: "config/read",
          result: { config: { sandbox_mode: "read-only", approval_policy: "never" }, origins: {} },
        })),
      })
    );

    try {
      await flow(root);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }

      await rm(root, { recursive: true, force: true });
    }
  });
}
