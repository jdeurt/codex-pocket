import { CodexRpc } from "../src/server/rpc";
import assert from "node:assert/strict";
import { configSchema } from "../src/server/config";
import { deliverMessage } from "../src/server/delivery";
import { initialSnapshot } from "../src/lib/protocol";
import { resumePocket } from "../src/server/pocket-runtime";
import test from "node:test";

test("resume and new turns apply the computer's effective effort without overriding other saved settings", async (t) => {
  const rpc = new CodexRpc();
  const config = configSchema.parse({ threadId: "saved-thread", cwd: "/tmp" });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  t.mock.method(rpc, "request", async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });

    if (method === "config/read") {
      return { config: { model_reasoning_effort: "medium", developer_instructions: "Existing instructions" } };
    }

    return method === "thread/resume"
      ? { thread: { id: config.threadId, turns: [] }, model: "saved-model", reasoningEffort: "medium" }
      : { turn: { id: "turn", status: "inProgress", items: [] } };
  });
  const resumed = await resumePocket(rpc, config);
  const state = { ...structuredClone(initialSnapshot), reasoningEffort: resumed.reasoningEffort };
  await deliverMessage(rpc, config, state, { id: "message", text: "Hello", status: "sending" });
  const resume = calls.find((call) => call.method === "thread/resume")?.params;
  assert.deepEqual(resume?.config, { model_reasoning_effort: "medium" });
  assert.equal(resume?.model, undefined);
  assert.equal(resume?.approvalPolicy, undefined);
  assert.equal(resume?.sandbox, undefined);
  assert.match(String(resume?.developerInstructions), /^Existing instructions/);
  assert.equal(calls.find((call) => call.method === "turn/start")?.params.effort, "medium");
});
