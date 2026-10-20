import { type Config, configSchema } from "../../src/server/config";
import { type Options, type SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { calibrationPrompt } from "./conformance";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

export const simulatorArgs = [
  "--import",
  fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
  fileURLToPath(new URL("cli.ts", import.meta.url)),
];

/**
Configure the production Codex transport to start only Node and the checked-in simulator.
@param cwd - Isolated working folder.
@returns Native transport configuration.
*/
export function simulatorConfig(cwd: string): Config {
  return configSchema.parse({
    cwd,
    threadId: "simulator-parent",
    codexBinary: process.execPath,
    serverArgs: simulatorArgs,
  });
}

/**
Hold streaming input open across initialization, controls and terminal result.
@param options - Native or simulator SDK launch options.
@returns Real SDK query with explicit release and cleanup callbacks.
*/
export function controlledClaude(options: Options) {
  const ready = Promise.withResolvers<undefined>();
  const finished = Promise.withResolvers<undefined>();
  const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
    await ready.promise;
    yield {
      type: "user",
      message: { role: "user", content: calibrationPrompt },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    };
    await finished.promise;
  };
  const run = query({ prompt: prompt(), options });

  return {
    run,
    release: () => {
      ready.resolve(undefined);
    },
    close: () => {
      finished.resolve(undefined);
      run.close();
    },
  };
}

/**
Connect the actual Claude SDK to a Node-only simulator with no inherited credentials or native binaries.
@param cwd - Isolated working folder.
@param scenario - Explicit fixture file.
@param options - Additional SDK callbacks for whole-flow tests.
@returns Query and deterministic prompt-release controls.
*/
export function simulatedClaude(cwd: string, scenario: string, options: Options = {}) {
  return controlledClaude({
    ...options,
    cwd,
    pathToClaudeCodeExecutable: process.execPath,
    spawnClaudeCodeProcess: () =>
      spawn(process.execPath, simulatorArgs, {
        cwd,
        env: {
          NODE_ENV: "test",
          PATH: "",
          HOME: cwd,
          CODEX_HOME: cwd,
          CLAUDE_CONFIG_DIR: cwd,
          POCKET_SIMULATOR_HARNESS: "claude",
          POCKET_SIMULATOR_SCENARIO: scenario,
        },
        stdio: "pipe",
      }),
  });
}

/**
Write the complete scenario before starting a subprocess that could read it immediately.
@param cwd - Isolated working folder.
@param scenario - JSON fixture data.
@param options - Additional SDK callbacks.
@returns Query host after its fixture is durable.
*/
export async function preparedClaude(cwd: string, scenario: unknown, options: Options = {}) {
  const filename = `${cwd}/scenario.json`;

  await writeFile(filename, JSON.stringify(scenario));

  return simulatedClaude(cwd, filename, options);
}
