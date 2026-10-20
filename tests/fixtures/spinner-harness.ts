// Deterministic app-server fixture. This process never invokes a model or a live session.
import { createInterface } from "node:readline";
import { fixtureRequestSchema } from "./replay-protocol";

const turn = { id: "spinner-turn", status: "inProgress", items: [] };
const results = new Map<string, unknown>([
  ["initialize", {}],
  ["config/read", { config: { sandbox_mode: "read-only", approval_policy: "never" } }],
  [
    "thread/resume",
    {
      thread: { id: "spinner-fixture", name: "Spinner fixture", turns: [turn] },
      model: "fixture",
      reasoningEffort: "low",
    },
  ],
  ["thread/turns/list", { data: [turn], nextCursor: null }],
]);

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method = "" } = fixtureRequestSchema.parse(JSON.parse(line));

  if (id === undefined) {
    return;
  }

  process.stdout.write(JSON.stringify({ id, result: results.get(method) ?? {} }) + "\n");
});
