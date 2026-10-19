// Deterministic app-server fixture. This process never invokes a model or a live session.
import { createInterface } from "node:readline";

const turn = { id: "spinner-turn", status: "inProgress", items: [] };
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);

  if (id === undefined) {
    return;
  }

  const results = {
    initialize: {},
    "config/read": { config: { sandbox_mode: "read-only", approval_policy: "never" } },
    "thread/resume": {
      thread: { id: "spinner-fixture", name: "Spinner fixture", turns: [turn] },
      model: "fixture",
      reasoningEffort: "low",
    },
    "thread/turns/list": { data: [turn], nextCursor: null },
  };
  process.stdout.write(JSON.stringify({ id, result: results[method] ?? {} }) + "\n");
});
