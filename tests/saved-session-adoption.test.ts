import { type Thread, object, string } from "../src/lib/protocol";
import { inspectAdoption, listAdoptableSessions } from "../src/server/session-adoption";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { CodexAdapter } from "../src/server/harness/codex";
import { DelegationStore } from "../src/server/delegations";
import { SimulatorClient } from "./simulators/client";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { simulatorConfig } from "./simulators/launch";

/**
Populate one persisted assignment before disconnecting its original native client.
@param client - Original simulator connection.
@param store - Durable Pocket registry.
@param directory - Isolated native working directory.
@param scenario - Launch scenario filename.
@returns Ready saved-session fixture.
*/
async function prepareSaved(client: SimulatorClient, store: DelegationStore, directory: string, scenario: string) {
  const started = await client.call("thread/start", { cwd: directory, ephemeral: false });
  const threadId = string(object(started.thread).id);

  await client.call("turn/start", { threadId, input: [{ type: "text", text: "Original saved assignment" }] });

  return { client, store, directory, scenario, threadId, config: simulatorConfig(directory) };
}

/**
Prepare saved native history and launch-only simulator configuration in an isolated directory.
@param t - Test context owning files and environment restoration.
@returns Original session, durable store and simulator-backed production configuration.
*/
async function savedSession(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-saved-"));
  const filename = path.join(directory, "state.json");
  const scenario = path.join(directory, "scenario.json");
  const client = new SimulatorClient({ stateFile: filename });
  const store = new DelegationStore(directory);
  const before = { state: process.env.POCKET_SIMULATOR_STATE, scenario: process.env.POCKET_SIMULATOR_SCENARIO };

  process.env.POCKET_SIMULATOR_STATE = filename;
  process.env.POCKET_SIMULATOR_SCENARIO = scenario;
  t.after(async () => {
    if (before.state === undefined) {
      delete process.env.POCKET_SIMULATOR_STATE;
    } else {
      process.env.POCKET_SIMULATOR_STATE = before.state;
    }

    if (before.scenario === undefined) {
      delete process.env.POCKET_SIMULATOR_SCENARIO;
    } else {
      process.env.POCKET_SIMULATOR_SCENARIO = before.scenario;
    }

    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(scenario, JSON.stringify({ scripts: [] }));
  await client.initialize();
  store.saveParent("parent", { cwd: directory, policy: { sandbox: "read-only", approval: "never" } });

  return prepareSaved(client, store, directory, scenario);
}

/**
Provide a schema-valid config/read response needed by the real saved-session adapter.
@param filename - Isolated simulator scenario file.
*/
async function writeConfiguration(filename: string) {
  await writeFile(
    filename,
    JSON.stringify({
      scripts: [
        {
          method: "config/read",
          result: {
            config: {
              model: "simulator-model",
              model_provider: "openai",
              model_context_window: null,
              model_auto_compact_token_limit: null,
              model_reasoning_effort: null,
              model_reasoning_summary: null,
              model_verbosity: null,
              approval_policy: "never",
              approvals_reviewer: "user",
              sandbox_mode: "read-only",
              sandbox_workspace_write: null,
              forced_chatgpt_workspace_id: null,
              forced_login_method: null,
              web_search: null,
              tools: null,
              profile: null,
              profiles: {},
              instructions: null,
              developer_instructions: null,
              compact_prompt: null,
              analytics: null,
              service_tier: null,
            },
            origins: {},
            layers: null,
          },
        },
      ],
    })
  );
}

await test("saved adoption preserves history and resumes only when a follow-up is explicitly sent", async (t) => {
  const fixture = await savedSession(t);
  const input = { threadId: fixture.threadId, title: "Saved work", idempotencyKey: "saved" };
  const session = await inspectAdoption(fixture.config, input);
  const child = fixture.store.adoptions.adopt("parent", input, session);
  const adapter = new CodexAdapter({
    config: fixture.config,
    child: { ...child, sessionStarted: true },
    callbacks: {
      metadata: (data) => {
        fixture.store.metadata("parent", child.id, data);
      },
      output: (text) => {
        assert.equal(typeof text, "string");
      },
      request: () => Promise.reject(new Error("Unexpected request")),
    },
  });

  assert.equal(child.sessionId, fixture.threadId);
  assert.deepEqual(fixture.store.queue.list("parent", child.id), []);
  await writeConfiguration(fixture.scenario);

  try {
    assert.equal(await adapter.open(), fixture.threadId);
    assert.match(JSON.stringify(await adapter.history()), /Original saved assignment/u);
    await adapter.run("followup", "Explicit continuation");
    assert.match(JSON.stringify(await adapter.history()), /Explicit continuation/u);
  } finally {
    await adapter.close();
  }

  assert.equal(
    new SimulatorClient({ stateFile: path.join(fixture.directory, "state.json") }).server.store.get(fixture.threadId)
      .turns.length,
    2
  );
});

await test("saved-session discovery leaves native history unchanged and active saved sessions are rejected", async (t) => {
  const fixture = await savedSession(t);
  const page = await listAdoptableSessions(fixture.config, { archived: false });
  const thread: Thread = fixture.client.server.store.get(fixture.threadId);

  assert.match(JSON.stringify(page), new RegExp(fixture.threadId, "u"));
  assert.equal(thread.turns.length, 1);
  thread.turns[0].status = "inProgress";
  thread.status = { type: "active", activeFlags: [] };
  fixture.client.server.store.save();
  await assert.rejects(
    inspectAdoption(fixture.config, {
      threadId: fixture.threadId,
      title: "Busy",
      idempotencyKey: "busy",
    }),
    /owning app-server socketPath/u
  );
  assert.equal(fixture.store.list("parent").length, 0);
});
