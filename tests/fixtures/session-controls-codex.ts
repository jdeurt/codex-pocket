import { CodexSimulator } from "../simulators/codex";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { object } from "../../src/lib/protocol";
import { validateMessage } from "../simulators/contract";
import { writeFixtureRecord } from "./sequential-rpc";

const counters = {
  inputTokens: 100,
  cachedInputTokens: 20,
  outputTokens: 10,
  reasoningOutputTokens: 5,
  totalTokens: 110,
};
const simulator = new CodexSimulator(writeFixtureRecord, {
  scripts: [
    {
      method: "config/read",
      result: {
        config: {
          sandbox_mode: "read-only",
          approval_policy: "never",
          model: "initial-model",
          model_reasoning_effort: "high",
        },
        origins: {},
      },
    },
  ],
});
const thread = simulator.store.create({ model: "initial-model" });
const lines = createInterface({ input: process.stdin });
const usage = {
  method: "thread/tokenUsage/updated",
  params: {
    threadId: "settings-parent",
    turnId: "active",
    tokenUsage: { total: counters, last: counters, modelContextWindow: 1000 },
  },
};

simulator.store.threads.delete(thread.id);
thread.id = "settings-parent";
thread.sessionId = thread.id;
thread.turns = [{ id: "active", status: "inProgress", items: [] }];
simulator.store.threads.set(thread.id, thread);
validateMessage(usage.method, usage, "ServerNotification");

for await (const line of lines) {
  const request = object(JSON.parse(line));

  appendFileSync("requests.jsonl", JSON.stringify({ ...request, pid: process.pid }) + "\n");

  if (request.method === "thread/resume") {
    writeFixtureRecord(usage);
  }

  await simulator.receive(request);
}
