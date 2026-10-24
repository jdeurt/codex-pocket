import { type Data, object, string } from "../../src/lib/protocol";
import { type CodexRpc } from "../../src/server/rpc";
import { type Query } from "@anthropic-ai/claude-agent-sdk";
import { RpcNotificationEvent } from "../../src/server/rpc-events";
import assert from "node:assert/strict";

const NOT_FOUND = -1;
const TURN_TIMEOUT_MS = 60_000;
export const calibrationReply = "POCKET_SIMULATOR_OK";
export const calibrationPrompt = `Reply exactly ${calibrationReply}. Do not use any tools.`;

/**
Compare native filesystem behavior in a disposable directory with the simulator's virtual filesystem.
@param rpc - Production protocol transport.
@param cwd - Isolated calibration root.
*/
async function filesystemConformance(rpc: CodexRpc, cwd: string) {
  const directory = `${cwd}/filesystem`;
  const source = `${directory}/source.txt`;
  const copy = `${directory}/copy.txt`;
  const encoded = Buffer.from("Pocket simulator calibration\n").toString("base64");

  await rpc.request("fs/createDirectory", { path: directory });
  await rpc.request("fs/writeFile", { path: source, dataBase64: encoded });
  assert.deepEqual(await rpc.request("fs/readFile", { path: source }), { dataBase64: encoded });
  await rpc.request("fs/copy", { sourcePath: source, destinationPath: copy });
  assert.deepEqual(await rpc.request("fs/readFile", { path: copy }), { dataBase64: encoded });
  assert.equal(object(await rpc.request("fs/getMetadata", { path: copy })).isFile, true);
  assert.match(JSON.stringify(await rpc.request("fs/readDirectory", { path: directory })), /copy\.txt/);
  await rpc.request("fs/remove", { path: directory, recursive: true });
  await assert.rejects(rpc.request("fs/readFile", { path: source }));
}

/**
Read back actual native settings instead of trusting a mutation receipt.
@param rpc - Production transport.
@param threadId - Isolated thread.
@param model - Expected selected model.
*/
async function assertSettings(rpc: CodexRpc, threadId: string, model: string) {
  const read = await rpc.request("thread/read", { threadId });

  assert.equal(read.thread.model, model);
  assert.equal(read.thread.reasoningEffort, "low");
}

/**
Check terminal state and the lifecycle ordering shared by native and simulated Codex.
@param completed - Event promise.
@param events - Observed methods.
*/
async function assertCompletion(completed: Promise<Data>, events: string[]) {
  const response = await completed;
  const turn = object(response.turn);
  const firstStarted = events.indexOf("turn/started");
  const firstDelta = events.indexOf("item/agentMessage/delta");
  const lastCompleted = events.lastIndexOf("turn/completed");

  assert.equal(turn.status, "completed", JSON.stringify(turn.error));
  assert.ok(firstStarted !== NOT_FOUND && firstDelta > firstStarted && lastCompleted > firstDelta);
  assert.match(JSON.stringify(turn.items), new RegExp(calibrationReply));
}

/**
Exercise calibrated native edge cases before running one isolated inference turn.
@param rpc - Production transport.
@param cwd - Disposable working directory.
@param model - Model identity.
@param completed - Terminal native notification.
@param events - Observed event ordering.
@returns Explicit passing behavior names.
*/
async function codexSession(rpc: CodexRpc, cwd: string, model: string, completed: Promise<Data>, events: string[]) {
  const started = await rpc.request("thread/start", {
    cwd,
    model,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const threadId = started.thread.id;

  await assert.rejects(rpc.request("thread/read", { threadId, includeTurns: true }), /ephemeral/);
  await rpc.request("thread/settings/update", { threadId, model, effort: "low" });
  await assertSettings(rpc, threadId, model);
  await assert.rejects(
    rpc.request("turn/steer", { threadId, expectedTurnId: "missing", input: [{ type: "text", text: "probe" }] }),
    /no active turn/
  );
  await assert.rejects(rpc.request("turn/interrupt", { threadId, turnId: "missing" }), /no active turn/);
  await rpc.request("turn/start", { threadId, input: [{ type: "text", text: calibrationPrompt }] });
  await assertCompletion(completed, events);
  await filesystemConformance(rpc, cwd);

  return {
    passed: [
      "initialize",
      "ephemeral-read-rejection",
      "model-effort-readback",
      "idle-steer-rejection",
      "idle-interrupt-rejection",
      "streamed-turn-completion",
      "filesystem-write-read-copy-list-metadata-remove",
    ],
  };
}

/**
Run the same session and turn assertions against real Codex and its simulator.
@param rpc - Already initialized production Pocket transport.
@param cwd - Disposable working directory.
@param model - Explicit native or simulated model.
@returns Nonprivate behavior evidence for release review.
*/
export async function codexConformance(rpc: CodexRpc, cwd: string, model: string) {
  const completed = Promise.withResolvers<Data>();
  const events: string[] = [];
  const timer = setTimeout(() => {
    completed.reject(new Error("Codex calibration turn timed out"));
  }, TURN_TIMEOUT_MS);
  const observe = (event: Event) => {
    if (!(event instanceof RpcNotificationEvent)) {
      return;
    }

    events.push(event.notification.method);

    if (event.notification.method === "turn/completed") {
      completed.resolve(event.notification.params);
    }
  };

  rpc.addEventListener("event", observe);

  return codexSession(rpc, cwd, model, completed.promise, events).finally(() => {
    clearTimeout(timer);
    rpc.removeEventListener("event", observe);
  });
}

/**
Exercise the actual SDK controls and terminal message stream against either native backend.
@param run - Real SDK Query connected to the selected backend.
@param model - Model alias accepted by both.
@param release - Release the held first prompt after controls complete.
@returns Behavior evidence without account details or transcripts.
*/
export async function claudeConformance(run: Query, model: string, release: () => void) {
  const initialization = await run.initializationResult();
  const models = await run.supportedModels();
  const receipt = await run.interrupt();

  assert.ok(Array.isArray(initialization.commands));
  assert.ok(models.length > 0);
  assert.deepEqual(receipt, { still_queued: [] });
  assert.deepEqual(await run.mcpServerStatus(), []);
  await run.setModel(model);
  await run.setPermissionMode("default");
  release();

  for await (const message of run) {
    if (message.type === "result") {
      assert.equal(message.subtype, "success");
      assert.equal(message.is_error, false);
      assert.match(string(object(message).result), new RegExp(calibrationReply));

      return {
        passed: [
          "initialize",
          "model-catalog",
          "idle-interrupt-receipt",
          "mcp-catalog",
          "set-model",
          "set-permissions",
          "streamed-turn-completion",
        ],
      };
    }
  }

  throw new Error("Claude ended without a terminal result");
}
