import { type Thread, initialSnapshot, object } from "../src/lib/protocol";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { pocketInstructions, resumePocket } from "../src/server/pocket-runtime";
import { CodexRpc } from "../src/server/rpc";
import assert from "node:assert/strict";
import { configSchema } from "../src/server/config";
import { createHash } from "node:crypto";
import { loadHistory } from "../src/server/history";
import path from "node:path";
import { seedThread } from "./seed-thread";
import { visibleSnapshot } from "../src/server/visible-snapshot";
import { z } from "zod";

const rolloutRowSchema = z.object({
  type: z.string(),
  payload: z.object({
    base_instructions: z.object({ text: z.string() }).optional(),
    role: z.string().optional(),
    content: z.array(z.object({ text: z.string().optional() })).default([]),
  }),
});

async function checkInstructions() {
  const marker = "POCKET_NATIVE_PROMPT";
  const results: { stage: string; marker: string; baseHash: string; promptCopies: number }[] = [];

  await mkdir(".local", { recursive: true });
  const directory = await mkdtemp(path.resolve(".local", "instructions-check-"));
  const project = path.join(directory, "project");

  await mkdir(project);
  process.env.CODEX_POCKET_STATE_DIR = path.join(directory, "state");
  const existing = `The configured integration marker is ${marker}. When asked for the configured integration marker, reply exactly ${marker}.`;
  const instructions = pocketInstructions(existing, false);

  assert.ok(instructions.startsWith(existing + "\n\n"));
  let config = configSchema.parse({
    threadId: "bootstrap",
    cwd: project,
    codexBinary: process.env.CODEX_BINARY ?? "codex",
    serverArgs: [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      `developer_instructions=${JSON.stringify(existing)}`,
    ],
  });
  let rpc = new CodexRpc();
  let thread: Thread | undefined;
  let originalBase: string | undefined;

  async function close() {
    if (!rpc.running) {
      return;
    }

    const disconnected = new Promise((resolve) => rpc.once("disconnect", resolve));

    rpc.close();
    await disconnected;
  }

  async function check(stage: string) {
    const replies: string[] = [];
    const listener = (event: { method: string; params: Record<string, unknown> }) => {
      const item = object(event.params.item);

      if (event.method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
        replies.push(item.text);
      }
    };

    rpc.on("event", listener);

    try {
      await seedThread(rpc, config.threadId, "Reply with the configured integration marker only. Do not use tools.");
    } finally {
      rpc.off("event", listener);
    }

    assert.deepEqual(replies, [marker]);
    assert.ok(thread);
    assert.equal(typeof thread.path, "string");
    assert.ok(typeof thread.path === "string");
    const content = await readFile(thread.path, "utf8");
    const rows = content
      .trim()
      .split("\n")
      .map((line) => rolloutRowSchema.parse(JSON.parse(line)));
    const metadata = rows.find((row) => row.type === "session_meta");

    assert.ok(metadata?.payload.base_instructions);
    const base = metadata.payload.base_instructions.text;

    assert.ok(base.length > 0);
    assert.equal(base.includes("You are Pocket"), false);
    originalBase ??= base;
    assert.equal(base, originalBase);
    const developerTexts = rows
      .filter((row) => row.type === "response_item" && row.payload.role === "developer")
      .flatMap((row) => row.payload.content)
      .map((part) => part.text ?? "");
    const promptCopies = developerTexts.filter((text) => text.includes(instructions)).length;

    assert.equal(promptCopies, 1);
    const turns = await loadHistory(rpc, { id: config.threadId, turns: [] });
    const phone = visibleSnapshot({ ...initialSnapshot, connection: "connected", turns });

    assert.equal(JSON.stringify(phone).includes("Pocket displays image-view"), false);
    const result = { stage, marker, baseHash: createHash("sha256").update(base).digest("hex"), promptCopies };

    results.push(result);
    console.log(JSON.stringify(result));
  }

  try {
    await rpc.connect(config);
    const started = await rpc.request("thread/start", {
      cwd: project,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: instructions,
    });

    thread = started.thread;
    config = { ...config, threadId: thread.id };
    await check("initial Pocket turn");
    await check("next turn");
    await close();
    rpc = new CodexRpc();
    await rpc.connect(config);
    await resumePocket(rpc, config);
    await check("fresh process resume");
    await close();
    rpc = new CodexRpc();
    await rpc.connect(config);
    await resumePocket(rpc, config);
    await check("second reconnect");
    await assert.rejects(readFile(path.join(directory, "state", "instructions.json")), { code: "ENOENT" });
    await writeFile(
      path.join(directory, "results.json"),
      JSON.stringify({ threadId: thread.id, results }, undefined, 2) + "\n"
    );
  } finally {
    if (thread) {
      if (!rpc.running) {
        rpc = new CodexRpc();
        await rpc.connect(config);
      }

      await rpc.request("thread/archive", { threadId: thread.id });
    }

    await close();
  }
}

await checkInstructions();
