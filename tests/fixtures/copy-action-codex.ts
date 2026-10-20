// Isolated app-server protocol fixture. Never launches a model or executes turns.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fixtureRequestSchema } from "./replay-protocol";
import { z } from "zod";

const log = z.string().parse(process.argv[2]);
const thread = { id: "copy-prompt-fixture", turns: [] };
const config = {
  developer_instructions: "Keep all existing configured instructions. ORIGINAL_PROMPT_SENTINEL",
  sandbox_mode: "read-only",
  approval_policy: "never",
  model: "fixture-model",
  model_reasoning_effort: "high",
};
const results = new Map<string, unknown>([
  ["initialize", {}],
  ["config/read", { config }],
  ["thread/start", { thread, model: config.model, reasoningEffort: "high" }],
  ["thread/resume", { thread, model: config.model, reasoningEffort: "high" }],
]);

/**
Answers only non-mutating bootstrap methods required by the prompt preservation flow.
@param id - Validated native request identity.
@param method - Decoded native request method.
*/
function reply(id: string | number, method = "") {
  const result = results.get(method);

  if (!result) {
    process.stdout.write(JSON.stringify({ id, error: { code: -32_601, message: "Unexpected RPC" } }) + "\n");

    return;
  }

  process.stdout.write(JSON.stringify({ id, result }) + "\n");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = fixtureRequestSchema.parse(JSON.parse(line));

  appendFileSync(log, JSON.stringify({ pid: process.pid, ...message }) + "\n");

  if (message.id === undefined) {
    return;
  }

  reply(message.id, message.method);
});
