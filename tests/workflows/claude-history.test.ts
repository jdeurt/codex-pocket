import { type AdapterOptions } from "../../src/server/harness/types";
import { type AgentRecord } from "../../src/server/agent-sources";
import { AgentReadCache } from "../../src/server/agent-read-cache";
import { ClaudeAdapter } from "../../src/server/harness/claude";
import { DelegationStore } from "../../src/server/delegations";
import { claudeWriteHistory, claudeWriteMessages } from "../fixtures/claude-writes";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { object } from "../../src/lib/protocol";
import { randomUUID } from "node:crypto";
import { readClaude } from "../../src/server/agent-claude";
import { simulatorArgs, simulatorConfig } from "../simulators/launch";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TIMEOUT_MS = 30_000;
const PARENT = "write-provenance-parent";

/** Verify native results, private persistence and both saved transcript readers.
@param root - Isolated native project directory.
@param store - Real private delegation database.
@param adapter - Production adapter consuming the SDK stream.
@param options - Child scope reused after restoration.
@param sessionId - Stable native session.
*/
async function verifyReload(
  root: string,
  store: DelegationStore,
  adapter: ClaudeAdapter,
  options: AdapterOptions,
  sessionId: string
) {
  const child = options.child;
  const messages = claudeWriteMessages(sessionId);

  await writeFile(path.join(root, "scenario.json"), JSON.stringify({ claude: { messages } }));
  const result = await adapter.run(randomUUID(), "Exercise write outputs");

  assert.equal(result.status, "completed");
  const saved = store.get(PARENT, child.id);

  const writes = object(object(JSON.parse(saved.metadata)).claudeWrites);

  assert.deepEqual(
    Object.keys(writes).toSorted((a, b) => a.localeCompare(b)),
    ["create", "update"]
  );
  assert.doesNotMatch(saved.metadata, /Private file content|Original private content/);
  const project = path.join(root, "claude", "projects", root.replaceAll(/[^a-zA-Z0-9]/g, "-"));

  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, `${sessionId}.jsonl`), claudeWriteHistory(messages, sessionId, root));
  const restored = new ClaudeAdapter({ ...options, child: { ...options.child, metadata: saved.metadata } });
  const history = await restored.history();
  const labels = history.filter((message) => message.role === "tool").map((message) => message.item?.toolLabels);

  assert.deepEqual(labels, [["Created /fixture/create.txt"], ["Edited /fixture/update.txt"], [], [], [], []]);
  const liveHistory = await adapter.history();

  assert.deepEqual(
    liveHistory.map((message) => message.item?.toolLabels),
    history.map((message) => message.item?.toolLabels)
  );
  const record: AgentRecord = {
    agent: {
      id: child.id,
      parentId: PARENT,
      name: child.title,
      source: "side-pocket",
      harness: "claude",
      status: "idle",
      preview: "",
    },
    cwd: root,
    sessionId,
    pocket: saved,
  };

  await readClaude(record, sessionId);
  assert.deepEqual(
    record.turns
      ?.flatMap((turn) => turn.items)
      .filter((item) => item.type === "toolTrace")
      .map((item) => item.toolLabels),
    labels
  );
  await restored.close();
  const cache = new AgentReadCache();

  record.pocket = { ...saved, metadata: "{}" };
  await cache.full(record, false, 1);
  const legacyTools = record.turns.flatMap((turn) => turn.items).filter((item) => item.type === "toolTrace");

  assert.deepEqual(
    legacyTools.map((item) => item.toolLabels),
    labels.map(() => [])
  );
  record.pocket = saved;
  await cache.full(record, false, 1);
  const refreshedTools = record.turns.flatMap((turn) => turn.items).filter((item) => item.type === "toolTrace");

  assert.deepEqual(
    refreshedTools.map((item) => item.toolLabels),
    labels
  );
}

/** Exercise the production adapter, durable metadata, SDK reader and catalog projection together.
@param root - Isolated project and state directory with a credential-free simulator executable.
*/
async function verifyWrites(root: string) {
  const store = new DelegationStore(root);
  const sessionId = randomUUID();
  const policy = { sandbox: "danger-full-access", approval: "never" };

  store.saveParent(PARENT, { cwd: root, policy });
  const child = store.create(PARENT, {
    title: "Write provenance",
    body: "Create and replace files",
    harness: "claude",
    idempotencyKey: "writes",
  });

  store.setSession(PARENT, child.id, sessionId);
  const options: AdapterOptions = {
    config: simulatorConfig(root),
    child: { ...child, cwd: root, policy, sessionId },
    callbacks: {
      output: (text) => {
        assert.equal(text, "SIMULATED_REPLY");
      },
      request: () => Promise.reject(new Error("Unexpected native request")),
      metadata: (data) => {
        store.metadata(PARENT, child.id, data);
      },
    },
  };
  const adapter = new ClaudeAdapter(options);

  await verifyReload(root, store, adapter, options, sessionId).finally(async () => {
    await adapter.close();
    store.close();
  });
}

await test(
  "Claude write provenance survives real SDK streaming and saved-history reload",
  { timeout: TIMEOUT_MS },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pocket-claude-writes-"));
    const environment = {
      CODEX_POCKET_STATE_DIR: root,
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      POCKET_CLAUDE_BINARY: path.join(root, "claude-simulator"),
      POCKET_SIMULATOR_NODE: process.execPath,
      POCKET_SIMULATOR_LOADER: simulatorArgs[1],
      POCKET_SIMULATOR_CLI: simulatorArgs[2],
      POCKET_SIMULATOR_HARNESS: "claude",
      POCKET_SIMULATOR_SCENARIO: path.join(root, "scenario.json"),
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));

    Object.assign(process.env, environment);

    t.after(async () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }

      await rm(root, { recursive: true, force: true });
    });

    await writeFile(
      environment.POCKET_CLAUDE_BINARY,
      '#!/bin/sh\nexec "$POCKET_SIMULATOR_NODE" --import "$POCKET_SIMULATOR_LOADER" "$POCKET_SIMULATOR_CLI" "$@"\n',
      { mode: 0o700 }
    );
    await verifyWrites(root);
  }
);
