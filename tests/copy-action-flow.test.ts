import { mkdtemp, readFile, rm } from "node:fs/promises";
import { pocketInstructions, resumePocket } from "../src/server/pocket-runtime";
import { CodexRpc } from "../src/server/rpc";
import assert from "node:assert/strict";
import { configSchema } from "../src/server/config";
import { delegations } from "../src/server/delegations";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const STAGES = ["initial", "restart", "reconnect"];

test("canonical main prompt retains copy guidance and existing instructions across fresh process reconnects without user-message injection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-copy-prompt-flow-"));
  const oldState = process.env.CODEX_POCKET_STATE_DIR;
  process.env.CODEX_POCKET_STATE_DIR = directory;
  const log = path.join(directory, "rpc.jsonl");
  const config = configSchema.parse({
    threadId: "copy-prompt-fixture",
    cwd: directory,
    codexBinary: process.execPath,
    serverArgs: [path.resolve("tests/fixtures/copy-action-codex.mjs"), log],
  });
  const existing = "Keep all existing configured instructions. ORIGINAL_PROMPT_SENTINEL";
  const instructions = pocketInstructions(existing, false);
  assert.ok(instructions.startsWith(existing + "\n\n"));

  for (const preserved of ["Pocket displays image-view output", "Use side_pocket_list", "schedule_create"]) {
    assert.ok(instructions.includes(preserved));
  }

  assert.ok(instructions.includes("To offer a dedicated Copy text button"));
  assert.ok(instructions.includes('```pocket-copy\n"Line 1\\nLine 2"\n```'));
  assert.ok(instructions.includes(String.raw`quotes as \"`));
  assert.ok(instructions.includes("backslashes as \\\\"));

  try {
    for (const stage of STAGES) {
      const rpc = new CodexRpc();

      try {
        await rpc.connect(config);

        if (stage === "initial") {
          await rpc.request("thread/start", { cwd: directory, developerInstructions: instructions });
        } else {
          await resumePocket(rpc, config);
        }
      } finally {
        await rpc.shutdown();
      }
    }

    const recorded = await readFile(log, "utf8");
    const messages = recorded
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(new Set(messages.map((message) => message.pid)).size, STAGES.length);
    const sessions = messages.filter((message) => ["thread/start", "thread/resume"].includes(message.method));
    assert.equal(sessions.length, STAGES.length);

    for (const session of sessions) {
      assert.equal(session.params.developerInstructions, instructions);
      assert.equal(session.params.developerInstructions.split("To offer a dedicated Copy text button").length, 2);
    }

    assert.equal(messages.filter((message) => message.method === "config/read").length, 2);
    assert.equal(
      messages.some((message) => /turn\/|message|steer/.test(message.method)),
      false
    );
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
