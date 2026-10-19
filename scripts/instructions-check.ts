import { type Thread, initialSnapshot } from "../src/lib/protocol";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { CodexRpc } from "../src/server/rpc";
import assert from "node:assert/strict";
import { configSchema } from "../src/server/config";
import { loadHistory } from "../src/server/history";
import path from "node:path";
import { resumePocket } from "../src/server/pocket-runtime";
import { seedThread } from "./seed-thread";
import { visibleSnapshot } from "../src/server/visible-snapshot";

class RejectedInjectionRpc extends CodexRpc {
  override request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return super.request<T>(
      method,
      method === "thread/inject_items" ? { ...params, threadId: "missing-integration-thread" } : params
    );
  }
}

async function checkInstructions() {
  await mkdir(".local", { recursive: true });
  const directory = await mkdtemp(path.resolve(".local", "instructions-check-"));
  const project = path.join(directory, "project");
  await mkdir(project);
  process.env.CODEX_POCKET_STATE_DIR = path.join(directory, "state");
  let config = configSchema.parse({
    threadId: "bootstrap",
    cwd: project,
    codexBinary: process.env.CODEX_BINARY ?? "codex",
  });
  let rpc = new CodexRpc();
  let threadId: string | undefined;
  let rollout: string | undefined;
  const results: { stage: string; marker: string; injections: number }[] = [];

  async function close() {
    if (!rpc.running) {
      return;
    }

    const disconnected = new Promise((resolve) => rpc.once("disconnect", resolve));
    rpc.close();
    await disconnected;
  }

  async function check(stage: string, marker: string, injections: number) {
    const replies: string[] = [];
    const listener = (event: { method: string; params: Record<string, unknown> }) => {
      const item = event.params.item as { type?: string; text?: string } | undefined;

      if (event.method === "item/completed" && item?.type === "agentMessage" && item.text) {
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
    assert.ok(rollout);
    const content = await readFile(rollout, "utf8");
    const rows = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const applied = rows.filter(
      (row) =>
        row.type === "response_item" &&
        row.payload?.role === "developer" &&
        JSON.stringify(row.payload.content).includes("Pocket displays image-view")
    );
    assert.equal(applied.length, injections);
    const turns = await loadHistory(rpc, { id: config.threadId, turns: [] });
    const phone = visibleSnapshot({ ...initialSnapshot, connection: "connected", turns });
    assert.equal(JSON.stringify(phone).includes("Pocket displays image-view"), false);
    results.push({ stage, marker, injections });
    console.log(JSON.stringify({ stage, marker, injections }));
  }

  async function reconnect(marker: string, rejectInjection = false) {
    await close();
    config = {
      ...config,
      serverArgs: [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        `developer_instructions=${JSON.stringify(`The configured integration marker is ${marker}. When asked for the configured integration marker, reply exactly ${marker}.`)}`,
      ],
    };
    rpc = rejectInjection ? new RejectedInjectionRpc() : new CodexRpc();
    await rpc.connect(config);
    const resumed = await resumePocket(rpc, config);
    rollout = (resumed.thread as Thread & { path: string }).path;
  }

  try {
    await rpc.connect(config);
    const started = await rpc.request<{ thread: Thread }>("thread/start", {
      cwd: project,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    threadId = started.thread.id;
    config = { ...config, threadId };
    await seedThread(rpc, threadId, "Reply exactly READY. Do not use tools.");
    await reconnect("POCKET_ALPHA");
    await check("first resume", "POCKET_ALPHA", 1);
    await check("next turn", "POCKET_ALPHA", 1);
    await reconnect("POCKET_ALPHA");
    await check("unchanged reconnect", "POCKET_ALPHA", 1);
    const receipt = path.join(directory, "state", "instructions.json");
    const beforeFailure = await readFile(receipt, "utf8");
    await assert.rejects(() => reconnect("POCKET_BETA", true));
    assert.equal(await readFile(receipt, "utf8"), beforeFailure);
    await reconnect("POCKET_BETA");
    await check("changed instructions", "POCKET_BETA", 2);
    await reconnect("POCKET_ALPHA");
    const REVISION_COUNT = 3;
    await check("restored instructions", "POCKET_ALPHA", REVISION_COUNT);
    await writeFile(path.join(directory, "results.json"), JSON.stringify({ threadId, results }, undefined, 2) + "\n");
  } finally {
    if (threadId) {
      if (!rpc.running) {
        rpc = new CodexRpc();
        await rpc.connect(config);
      }

      await rpc.request("thread/archive", { threadId });
    }

    await close();
  }
}

await checkInstructions();
