import { type AdapterOptions, type HarnessRequest } from "../src/server/harness/types";
import { type Data, object } from "../src/lib/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { CodexAdapter } from "../src/server/harness/codex";
import assert from "node:assert/strict";
import { configSchema } from "../src/server/config";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPLAY = path.resolve("tests/fixtures/codex-session-replay.ts");
const LOADER = path.resolve("node_modules/tsx/dist/loader.mjs");
const SESSION = "fixture-native-session";

interface Observations {
  requests: HarnessRequest[];
  metadata: Data[];
  output: string[];
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
    const resumed = { ...options, child: { ...options.child, sessionId, sessionStarted: true } };

    await adapter.close();
    await resumedSession(resumed);
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
