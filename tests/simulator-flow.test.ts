import { calibrationReply, claudeConformance, codexConformance } from "./simulators/conformance";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { preparedClaude, simulatorConfig } from "./simulators/launch";
import { CodexRpc } from "../src/server/rpc";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const FLOW_TIMEOUT_MS = 30_000;

await test(
  "production Codex transport completes calibrated native flows without Codex installed",
  { timeout: FLOW_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-sim-codex-"));
    const rpc = new CodexRpc();
    const scenario = path.join(root, "scenario.json");
    const previous = process.env.POCKET_SIMULATOR_SCENARIO;

    await writeFile(scenario, JSON.stringify({ turn: { chunks: ["POCKET_", "SIMULATOR_OK"] } }));
    process.env.POCKET_SIMULATOR_SCENARIO = scenario;

    try {
      await rpc.connect(simulatorConfig(root), "bare");
      await codexConformance(rpc, root, "simulator-model");
    } finally {
      await rpc.shutdown();

      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "POCKET_SIMULATOR_SCENARIO");
      } else {
        process.env.POCKET_SIMULATOR_SCENARIO = previous;
      }

      await rm(root, { recursive: true, force: true });
    }
  }
);

await test(
  "unmodified Claude SDK completes calibrated controls and output with a credential-free Node backend",
  { timeout: FLOW_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-sim-claude-"));
    const host = await preparedClaude(root, { claude: { text: calibrationReply } });

    try {
      await claudeConformance(host.run, "simulator-model", host.release);
    } finally {
      host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);

await test(
  "Claude SDK permission callbacks complete over the simulator's bidirectional wire",
  { timeout: FLOW_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-sim-permission-"));
    const decisions: string[] = [];
    const host = await preparedClaude(
      root,
      {
        claude: {
          text: calibrationReply,
          requests: [
            {
              subtype: "can_use_tool",
              tool_name: "Bash",
              input: { command: "never executed" },
              tool_use_id: "simulated-tool",
            },
          ],
        },
      },
      {
        canUseTool: (name, input) => {
          decisions.push(name);

          return Promise.resolve({ behavior: "deny", message: `Denied ${name}: ${JSON.stringify(input)}` });
        },
      }
    );

    try {
      await claudeConformance(host.run, "simulator-model", host.release);
      assert.deepEqual(decisions, ["Bash"]);
    } finally {
      host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
