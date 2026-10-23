import { type AdapterOptions, type HarnessRequest } from "../src/server/harness/types";
import { type Data, object } from "../src/lib/protocol";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { CodexAdapter } from "../src/server/harness/codex";
import { DelegationStore, type SidePocket } from "../src/server/delegations";
import assert from "node:assert/strict";
import { configSchema } from "../src/server/config";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPLAY = path.resolve("tests/fixtures/codex-session-replay.ts");
const LOADER = path.resolve("node_modules/tsx/dist/loader.mjs");
const SESSION = "fixture-native-session";
const EXISTING_INSTRUCTIONS = "Existing replay instructions\n\n";
const LAST_USER_MESSAGE = -2;

interface Observations {
  requests: HarnessRequest[];
  metadata: Data[];
  output: string[];
}

/**
Read the instructions received by the native subprocess at its session boundary.
@param directory - Isolated native working directory.
@returns Exact developer instructions received over RPC.
*/
async function receivedInstructions(directory: string) {
  const filename = path.join(directory, "native-session-params.json");
  const text = await readFile(filename, "utf8");
  const params = object(JSON.parse(text));

  assert.equal(typeof params.developerInstructions, "string");

  return String(params.developerInstructions);
}

/**
Continue adopted work through native RPC and verify its prompt and original transcript.
@param adapter - Native adapter for the adopted saved conversation.
@param child - Persisted adoption identity and current parent.
@param core - Shared instructions received before adoption.
*/
async function continueAdopted(adapter: CodexAdapter, child: SidePocket, core: string) {
  assert.equal(await adapter.open(), SESSION);
  const instructions = await receivedInstructions(child.cwd);
  const orientation = instructions.slice(EXISTING_INSTRUCTIONS.length);
  const sharedBody = core.slice(core.indexOf("Your filesystem"));
  const history = await adapter.history();

  assert.ok(instructions.startsWith(EXISTING_INSTRUCTIONS));
  assert.ok(
    orientation.startsWith(`You have been adopted as a Side Pocket by parent Pocket ${JSON.stringify(child.parentId)}.`)
  );
  assert.ok(orientation.includes(`Your existing Codex session ${JSON.stringify(SESSION)}`));
  assert.ok(orientation.includes(`ID ${JSON.stringify(child.id)}, titled ${JSON.stringify(child.title)}`));
  assert.match(orientation, /existing task context,\nhistory, and ongoing work/u);
  assert.ok(orientation.includes("saved session.\n\nYou are a Side Pocket,"));
  assert.ok(orientation.endsWith(sharedBody));
  assert.deepEqual(
    history.map((message) => message.text),
    ["choose", "Chosen Blue", "choose again", "Chosen Blue"]
  );
  await adapter.run("adopted-command", "Continue original work");
  const updated = await adapter.history();

  assert.deepEqual(updated.slice(0, history.length), history);
  assert.equal(updated.at(LAST_USER_MESSAGE)?.text, "Continue original work");
  assert.deepEqual(await adapter.run("silent-command", "silent"), { status: "completed", text: "" });
}

/**
Adopt the saved native conversation under a new parent and continue its original work.
@param options - Offline native configuration and saved session identity.
@param core - Shared Side Pocket instructions received before adoption.
*/
async function adoptedSession(options: AdapterOptions, core: string) {
  const store = new DelegationStore(options.child.cwd);
  const parentId = 'current-parent-"quoted"';

  store.saveParent(parentId, { cwd: options.child.cwd, policy: options.child.policy });
  const child = store.adoptions.adopt(
    parentId,
    { threadId: SESSION, title: "Adopted work", idempotencyKey: "adoption" },
    { threadId: SESSION, cwd: options.child.cwd }
  );
  const adapter = new CodexAdapter({ ...options, child });

  assert.deepEqual(store.queue.list(parentId, child.id), []);

  try {
    await continueAdopted(adapter, child, core);
  } finally {
    await adapter.close();
    store.close();
  }
}

/**
Exercise a complete delegated turn, native question, descendant scope and saved history.
@param adapter - Native Codex adapter connected only to the offline replay.
@param observed - Worker-side observations collected through real adapter callbacks.
@returns The created native session identity.
*/
async function initialSession(adapter: CodexAdapter, observed: Observations) {
  const sessionId = await adapter.open();
  const result = await adapter.run("initial-command", "choose");
  const history = await adapter.history();

  assert.equal(sessionId, SESSION);
  assert.deepEqual(result, { status: "completed", text: "Chosen Blue" });
  assert.deepEqual(observed.output, ["Chosen Blue"]);
  assert.equal(observed.requests[0].kind, "question");
  assert.equal(observed.requests[0].method, "item/tool/requestUserInput");
  assert.deepEqual(
    history.map((message) => message.role),
    ["user", "assistant"]
  );
  assert.deepEqual(
    history.map((message) => message.text),
    ["choose", "Chosen Blue"]
  );
  assert.equal(
    observed.metadata.some((value) => object(object(value.nativeAgents)["native-descendant"]).status === "waiting"),
    true
  );
  assert.equal(
    observed.metadata.some((value) => Object.hasOwn(object(value.nativeAgents), "unrelated-native")),
    false
  );

  return sessionId;
}

/**
Resume the durable native session and verify history survives a new child process.
@param options - Explicit offline configuration carrying the previously created native session.
*/
async function resumedSession(options: AdapterOptions) {
  const adapter = new CodexAdapter(options);

  try {
    const sessionId = await adapter.open();
    const history = await adapter.history();
    const result = await adapter.run("resumed-command", "choose again");
    const updated = await adapter.history();

    assert.equal(sessionId, SESSION);
    assert.equal(history.length, 2);
    assert.equal(result.status, "completed");
    assert.deepEqual(
      updated.map((message) => message.text),
      ["choose", "Chosen Blue", "choose again", "Chosen Blue"]
    );
    await adapter.archive();
  } finally {
    await adapter.close();
  }
}

/**
Reject a pending delegated turn when the owned native process disconnects.
@param options - Explicit offline configuration for the durable native session.
*/
async function disconnectedSession(options: AdapterOptions) {
  const adapter = new CodexAdapter(options);

  try {
    await adapter.open();
    await assert.rejects(adapter.run("disconnected-command", "disconnect"), /Codex disconnected/);
  } finally {
    await adapter.close();
  }
}

/**
Run the actual native stdio workflow inside a fresh private working directory.
@param directory - Temporary directory containing only this replay's history and logs.
*/
async function sessionFlow(directory: string) {
  const observed: Observations = { requests: [], metadata: [], output: [] };
  const options: AdapterOptions = {
    config: configSchema.parse({
      threadId: "offline-owner",
      cwd: directory,
      codexBinary: process.execPath,
      serverArgs: ["--import", LOADER, REPLAY],
    }),
    child: {
      id: "offline-child",
      parentId: "offline-owner",
      title: "Native stdio replay",
      cwd: directory,
      policy: { sandbox: "danger-full-access", approval: "never" },
    },
    callbacks: {
      metadata(value) {
        observed.metadata.push(structuredClone(value));
      },
      output(value) {
        observed.output.push(value);
      },
      request(value) {
        observed.requests.push(value);

        return Promise.resolve({ answers: { color: { answers: ["Blue"] } } });
      },
    },
  };
  const adapter = new CodexAdapter(options);

  try {
    const sessionId = await initialSession(adapter, observed);
    const instructions = await receivedInstructions(directory);
    const core = instructions.slice(EXISTING_INSTRUCTIONS.length);
    const resumed = { ...options, child: { ...options.child, sessionId, sessionStarted: true } };

    assert.ok(instructions.startsWith(`${EXISTING_INSTRUCTIONS}You are a Side Pocket,`));
    assert.match(core, /message category/u);
    assert.match(core, /caveman mode: at most 1–3 short sentences/u);
    assert.match(core, /does not shorten requested deliverables,\ndetailed answers, or completion reports/u);
    await adapter.close();
    await resumedSession(resumed);
    assert.equal(await receivedInstructions(directory), instructions);
    await adoptedSession(resumed, core);
    await disconnectedSession(resumed);
  } finally {
    await adapter.close();
  }
}

await test("offline native delegation preserves prompts, descendants, durable history and disconnect cleanup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-codex-session-"));
  const previousLog = process.env.CODEX_POCKET_LOG_DIR;
  const previousReplay = process.env.POCKET_CODEX_SESSION_REPLAY;

  process.env.CODEX_POCKET_LOG_DIR = path.join(directory, "logs");
  process.env.POCKET_CODEX_SESSION_REPLAY = "1";

  try {
    await sessionFlow(directory);
  } finally {
    if (previousLog === undefined) {
      delete process.env.CODEX_POCKET_LOG_DIR;
    } else {
      process.env.CODEX_POCKET_LOG_DIR = previousLog;
    }

    if (previousReplay === undefined) {
      delete process.env.POCKET_CODEX_SESSION_REPLAY;
    } else {
      process.env.POCKET_CODEX_SESSION_REPLAY = previousReplay;
    }

    await rm(directory, { recursive: true, force: true });
  }
});
