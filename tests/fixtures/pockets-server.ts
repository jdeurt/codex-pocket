import { mkdir, rm, writeFile } from "node:fs/promises";
import { CodexStore } from "../simulators/codex-store";
import { POCKETS_ORIGIN } from "./browser-defaults";
import path from "node:path";
import { runNextFixture } from "./next-server";
import { simulatorArgs } from "../simulators/launch";
import { seedCostFixture } from "./costs";

const HISTORY_ROWS = 320;
const USER_CADENCE = 4;

const directory = path.resolve(".local/pockets-fixture");

/** Seed a persisted parent after the fixture directory exists.
@returns Native parent identity and simulator persistence path.
*/
function seed() {
  const stateFile = path.join(directory, "codex.sqlite");
  const store = new CodexStore(stateFile);
  const parent = store.create({ cwd: process.cwd() });

  parent.name = "Original Pocket";
  parent.turns = [
    {
      id: "saved-notes",
      status: "completed",
      items: Array.from({ length: HISTORY_ROWS }, (_, index) => ({
        id: `note-${String(index)}`,
        type: index % USER_CADENCE === 0 ? "userMessage" : "agentMessage",
        content: [{ type: "text", text: `Earlier note ${String(index)}` }],
        text: `Earlier note ${String(index)}\n\nSaved conversation with **Markdown** and an independently recorded decision.`,
      })),
    },
  ];
  store.save();

  return { parent, stateFile };
}

/** Prepare only synthetic native sessions in a fixture-owned private directory.
@returns Original native-style parent and the shared test database path.
*/
async function prepare() {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  await writeFile(
    path.join(directory, "scenario.json"),
    JSON.stringify({
      turn: { chunks: ['Saved reply.\n\n```pocket-copy\n"café ✓\\nKeep exact text."\n```'] },
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

  return seed();
}

const prepared = await prepare();

seedCostFixture(path.join(directory, "state"), Date.now());

await runNextFixture("pockets", POCKETS_ORIGIN, {
  CODEX_THREAD_ID: prepared.parent.id,
  CODEX_CWD: process.cwd(),
  CODEX_BINARY: process.execPath,
  CODEX_SERVER_ARGS: JSON.stringify(simulatorArgs),
  CODEX_ALLOWED_ORIGINS: POCKETS_ORIGIN,
  CODEX_POCKET_STATE_DIR: path.join(directory, "state"),
  POCKET_SIMULATOR_STATE: prepared.stateFile,
  POCKET_SIMULATOR_SCENARIO: path.join(directory, "scenario.json"),
  CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
});
