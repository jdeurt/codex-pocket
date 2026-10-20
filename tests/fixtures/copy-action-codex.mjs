// Isolated app-server protocol fixture. Never launches a model or executes turns.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.argv[2];
const thread = { id: "copy-prompt-fixture", turns: [] };
const config = {
  developer_instructions: "Keep all existing configured instructions. ORIGINAL_PROMPT_SENTINEL",
  sandbox_mode: "read-only",
  approval_policy: "never",
  model: "fixture-model",
  model_reasoning_effort: "high",
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);

  appendFileSync(log, JSON.stringify({ pid: process.pid, ...message }) + "\n");

  if (message.id === undefined) {
    return;
  }

  const results = {
    initialize: {},
    "config/read": { config },
    "thread/start": { thread, model: config.model, reasoningEffort: "high" },
    "thread/resume": { thread, model: config.model, reasoningEffort: "high" },
  };

  const result = results[message.method];

  if (!result) {
    process.stdout.write(
      JSON.stringify({ id: message.id, error: { code: -32_601, message: "Unexpected RPC" } }) + "\n"
    );

    return;
  }

  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
});
