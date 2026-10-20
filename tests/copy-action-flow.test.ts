import { type Config, configSchema } from "../src/server/config";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { pocketInstructions, resumePocket } from "../src/server/pocket-runtime";
import { CodexRpc } from "../src/server/rpc";
import assert from "node:assert/strict";
import { delegations } from "../src/server/delegations";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

const promptParamsSchema = z.object({ developerInstructions: z.string().optional() });
const promptLogSchema = z.object({ pid: z.number(), method: z.string(), params: promptParamsSchema.default({}) });
const STAGES = ["initial", "restart", "reconnect"];

/**
Checks the canonical main prompt retains both configured instructions and literal copy-payload guidance.
@param existing - Configured native developer instructions.
@param instructions - Composed Pocket main-session instructions.
*/
function verifyPrompt(existing: string, instructions: string) {
  assert.ok(instructions.startsWith(existing + "\n\n"));

  for (const preserved of ["Image-view output and tool image content", "side_pocket_list", "schedule_create"]) {
    assert.ok(instructions.includes(preserved));
  }

  assert.ok(instructions.includes("Use a copy button when requested"));
  assert.ok(instructions.includes('```pocket-copy\n"Line 1\\nLine 2"\n```'));
  assert.ok(instructions.includes("Use JSON.stringify to encode the exact text"));
  assert.ok(instructions.includes("newlines, quotes, and backslashes"));
}

/**
Performs the real native handshake and session start or resume against the offline child.
@param rpc - Owned native transport for this fresh process.
@param config - Private fixture executable and thread configuration.
@param stage - Initial creation or subsequent saved-session stage.
@param instructions - Canonical main-session developer instructions.
@returns Completion of native start or resume acknowledgement.
*/
async function connectStage(rpc: CodexRpc, config: Config, stage: string, instructions: string) {
  await rpc.connect(config);

  if (stage === "initial") {
    await rpc.request("thread/start", { cwd: config.cwd, developerInstructions: instructions });
  } else {
    await resumePocket(rpc, config);
  }
}

/**
Runs three fresh native processes and waits for confirmed shutdown after each stage.
@param config - Private fixture executable and saved thread configuration.
@param instructions - Canonical main-session instructions to preserve.
@returns Completion of all native bootstrap stages.
*/
async function freshProcesses(config: Config, instructions: string) {
  for (const stage of STAGES) {
    const rpc = new CodexRpc();

    try {
      await connectStage(rpc, config, stage, instructions);
    } finally {
      await rpc.shutdown();
    }
  }
}

/**
Validates captured native calls without accepting injected user-message or turn operations.
@param log - Private fake-child JSONL request log.
@param instructions - Exact developer instructions expected in every session request.
@returns Completion of native request and process-identity assertions.
*/
async function verifyRequests(log: string, instructions: string) {
  const recorded = await readFile(log, "utf8");
  const messages = recorded
    .trim()
    .split("\n")
    .map((line) => promptLogSchema.parse(JSON.parse(line)));
  const sessions = messages.filter((message) => ["thread/start", "thread/resume"].includes(message.method));

  assert.equal(new Set(messages.map((message) => message.pid)).size, STAGES.length);
  assert.equal(sessions.length, STAGES.length);

  for (const session of sessions) {
    assert.equal(session.params.developerInstructions, instructions);
    assert.equal(session.params.developerInstructions.split("Use a copy button when requested").length, 2);
  }

  assert.equal(messages.filter((message) => message.method === "config/read").length, 2);
  assert.equal(
    messages.some((message) => /turn\/|message|steer/.test(message.method)),
    false
  );
}

/**
Checks prompt preservation through actual child stdio using only the private replay executable.
@param directory - Fresh private test state directory.
@returns Completion of prompt, native lifecycle and captured-request assertions.
*/
async function checkPrompt(directory: string) {
  const existing = "Keep all existing configured instructions. ORIGINAL_PROMPT_SENTINEL";
  const log = path.join(directory, "rpc.jsonl");
  const config = configSchema.parse({
    threadId: "copy-prompt-fixture",
    cwd: directory,
    codexBinary: process.execPath,
    serverArgs: [
      "--import",
      path.resolve("node_modules/tsx/dist/loader.mjs"),
      path.resolve("tests/fixtures/copy-action-codex.ts"),
      log,
    ],
  });
  const instructions = pocketInstructions(existing);

  verifyPrompt(existing, instructions);
  await freshProcesses(config, instructions);
  await verifyRequests(log, instructions);
}

await test("canonical main prompt retains copy guidance and existing instructions across fresh process reconnects without user-message injection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-copy-prompt-flow-"));
  const oldState = process.env.CODEX_POCKET_STATE_DIR;

  process.env.CODEX_POCKET_STATE_DIR = directory;

  try {
    await checkPrompt(directory);
  } finally {
    delegations().close();

    if (oldState === undefined) {
      delete process.env.CODEX_POCKET_STATE_DIR;
    } else {
      process.env.CODEX_POCKET_STATE_DIR = oldState;
    }

    await rm(directory, { recursive: true, force: true });
  }
});
