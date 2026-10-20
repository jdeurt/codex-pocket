import { access, mkdir, readFile } from "node:fs/promises";
import { Bridge } from "../src/server/bridge";
import { CodexRpc } from "../src/server/rpc";
import { DelegationWorker } from "../src/server/delegation-worker";
import assert from "node:assert/strict";
import { delegations } from "../src/server/delegations";
import nextEnv from "@next/env";
import path from "node:path";
import { readConfig } from "../src/server/config";
import { setTimeout } from "node:timers/promises";
import { string } from "../src/lib/protocol";
import { z } from "zod";

nextEnv.loadEnvConfig(process.cwd());
const base = await readConfig();

if (!base) {
  throw new Error("Configure Pocket before running the real delegation check.");
}

const CHECK_TIMEOUT_MS = 240_000;
const POLL_MS = 500;
const EXPECTED_CHILDREN = 2;
const EXPECTED_COMMANDS = 3;
const ACTIVE_CLOSE_TIMEOUT_MS = 30_000;
const LAST_INDEX = -1;

const root = path.resolve(".local", "delegation-check", crypto.randomUUID());
const cwd = path.join(root, "project");

await mkdir(cwd, { recursive: true });
process.env.CODEX_POCKET_STATE_DIR = path.join(root, "state");
const setup = new CodexRpc();

await setup.connect({ ...base, cwd }, "bare");
const { thread } = await setup.request("thread/start", {
  cwd,
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  ephemeral: false,
});

await setup.request("thread/name/set", { threadId: thread.id, name: "Pocket delegation integration check" });
await setup.shutdown();
process.env.CODEX_THREAD_ID = thread.id;
process.env.CODEX_CWD = cwd;
const config = { ...base, threadId: thread.id, cwd };
const parent = new Bridge();
const store = delegations();

let worker = new DelegationWorker(store, parent, config);

async function waitForCompletion() {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;

  let isFinished = false;

  while (Date.now() < deadline) {
    const isReply = parent.snapshot.turns
      .flatMap((turn) => turn.items)
      .some((item) => item.type === "agentMessage" && string(item.text).includes("DELEGATION_CHECK_OK"));
    const children = store.list(thread.id);

    if (
      isReply &&
      !parent.snapshot.activeTurnId &&
      children.length === EXPECTED_CHILDREN &&
      children.every((child) => child.status === "closed")
    ) {
      isFinished = true;
      break;
    }

    await setTimeout(POLL_MS);
  }

  assert.equal(isFinished, true, JSON.stringify(store.list(thread.id).map(({ title, status }) => ({ title, status }))));
}

async function verifyChildren() {
  const children = store.list(thread.id);

  for (const child of children) {
    const contents = await readFile(path.join(root, `${child.harness}.txt`), "utf8");

    assert.equal(contents.trim(), "BLUE");
    assert.equal(store.commands(thread.id, child.id).length, EXPECTED_COMMANDS);
    assert.equal(
      store.mail
        .history(thread.id, child.id)
        .some((mail) => mail.kind === "message" && mail.payload.includes("RESUME_DONE ORCHID_731")),
      true
    );
    const metadata = z.object({ pid: z.number() }).parse(JSON.parse(child.metadata));

    assert.throws(() => process.kill(metadata.pid, 0), { code: "ESRCH" });
  }

  return children;
}

async function waitUntil(isSatisfied: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + ACTIVE_CLOSE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isSatisfied()) {
      return;
    }

    await setTimeout(POLL_MS);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function doesFileExist(file: string) {
  try {
    await access(file);

    return true;
  } catch {
    return false;
  }
}

async function verifyActiveClose() {
  for (const child of store.list(thread.id)) {
    const marker = path.join(root, `${child.harness}-started`);
    const late = path.join(root, `${child.harness}-late`);

    store.resume(thread.id, child.id);
    store.send(
      thread.id,
      child.id,
      "active-close",
      `Run this shell command in the foreground: printf STARTED > '${marker}'; sleep 30; printf LATE > '${late}'. This tests interrupting an active command. Use no other tools and send no parent messages.`
    );
    await waitUntil(() => doesFileExist(marker), "active child command");
    const metadata = z.object({ pid: z.number() }).parse(JSON.parse(store.get(thread.id, child.id).metadata));

    store.closeChild(thread.id, child.id);
    await waitUntil(() => Promise.resolve(store.get(thread.id, child.id).status === "closed"), "process closure");
    assert.throws(() => process.kill(metadata.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(late), { code: "ENOENT" });
    assert.equal(store.commands(thread.id, child.id).at(LAST_INDEX)?.status, "cancelled");
    assert.equal(store.get(thread.id, child.id).sessionId, child.sessionId);
  }
}

try {
  await parent.ensureConnected();
  worker.start();
  await parent.send(
    crypto.randomUUID(),
    `Run this real Side Pocket integration check using Pocket's MCP tools.
Create exactly two Side Pockets: one with harness codex and title Codex check, one with harness claude and title Claude check. Give each a stable creation key.
First assignment for each child: remember token ORCHID_731, call message_parent with the question "QUESTION_READY: Which color should I write?", then finish its turn awaiting a follow-up. This specifically tests message_parent. Let children use that tool normally.
When a child's QUESTION_READY arrives, answer using side_pocket_send: write exactly BLUE to ${JSON.stringify(root)}/<harness>.txt (codex.txt or claude.txt), then call message_parent with "WRITE_DONE". Use stable send keys. Each child must do its own file operation.
When its WRITE_DONE arrives, close the child with side_pocket_close, resume the same ID with side_pocket_resume, then send one final follow-up asking it to recall ORCHID_731 and report "RESUME_DONE ORCHID_731" via message_parent. When that report arrives, close that child again.
Use side_pocket_list/get to track child IDs and pending work. Incoming child reports wake you automatically; yield between reports instead of polling. Do not create extra children or duplicate messages.
After both children complete this workflow and are closed, reply exactly DELEGATION_CHECK_OK. Do not use native subagents for this check.`
  );
  await waitForCompletion();
  const children = await verifyChildren();

  await verifyActiveClose();

  await worker.stop();
  worker = new DelegationWorker(store, parent, config);
  worker.start();
  await worker.tick();
  assert.deepEqual(
    store.list(thread.id).map((child) => child.sessionId),
    children.map((child) => child.sessionId)
  );
  console.info(
    "Real Codex parent delegated to Codex and Claude, received child questions, answered, closed processes, resumed saved sessions and received completion. Restart preserved identities without duplicate work."
  );
} finally {
  await worker.stop();
  parent.close();
  const cleanup = new CodexRpc();

  try {
    await cleanup.connect(config, "bare");
    await cleanup.request("thread/archive", { threadId: thread.id });

    for (const child of store.list(thread.id)) {
      if (child.harness === "codex" && child.sessionId) {
        await cleanup.request("thread/archive", { threadId: child.sessionId });
      }
    }
  } finally {
    await cleanup.shutdown();
  }
}
