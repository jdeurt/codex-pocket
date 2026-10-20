import { type Snapshot, string } from "../src/lib/protocol";
import { Bridge } from "../src/server/bridge";
import { CodexRpc } from "../src/server/rpc";
import assert from "node:assert/strict";
import { configSchema } from "../src/server/config";
import { isRecoveryMessageId } from "../src/server/recovery";
import { mkdir } from "node:fs/promises";
import nextEnv from "@next/env";
import path from "node:path";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const TURN_TIMEOUT_MS = 120_000;
nextEnv.loadEnvConfig(process.cwd());
const directory = path.resolve(".local", "recovery-check", crypto.randomUUID());
const project = path.join(directory, "project");
await mkdir(project, { recursive: true });
process.env.CODEX_POCKET_STATE_DIR = directory;
const config = configSchema.parse({
  threadId: "bootstrap",
  cwd: project,
  codexBinary: process.env.CODEX_BINARY ?? "codex",
});
const rpc = new CodexRpc();
await rpc.connect(config);
const { thread } = await rpc.request("thread/start", {
  cwd: project,
  sandbox: "read-only",
  approvalPolicy: "never",
  ephemeral: false,
});
await rpc.request("thread/name/set", { threadId: thread.id, name: "Pocket restart recovery integration check" });
rpc.close();
process.env.CODEX_THREAD_ID = thread.id;
process.env.CODEX_CWD = project;
process.env.CODEX_SERVER_ARGS = '["app-server","--listen","stdio://"]';
let bridge = new Bridge();

function waitFor(target: Bridge, check: (state: Snapshot) => boolean, label: string) {
  return new Promise<void>((resolve, reject) => {
    const pending: { timer?: NodeJS.Timeout } = {};

    function inspect() {
      if (!check(target.snapshot) && !target.snapshot.error) {
        return;
      }

      clearTimeout(pending.timer);
      target.off("snapshot", inspect);

      if (check(target.snapshot)) {
        resolve();
      } else {
        reject(new Error(`${label}: ${target.snapshot.error ?? "Unknown error"}`));
      }
    }

    pending.timer = setTimeout(() => {
      target.off("snapshot", inspect);
      reject(new Error(`Timed out waiting for ${label}`));
    }, TURN_TIMEOUT_MS);
    target.on("snapshot", inspect);
    inspect();
  });
}

const replies = (state: Snapshot) =>
  state.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "agentMessage")
    .map((item) => string(item.text));
const recoveryInputs = (state: Snapshot) =>
  state.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "userMessage" && isRecoveryMessageId(item.clientId));

function recoveryReply(state: Snapshot) {
  const turn = state.turns.findLast((entry) => entry.items.some((item) => isRecoveryMessageId(item.clientId)));

  if (turn?.status !== "completed") {
    return "";
  }

  const inputIndex = turn.items.findLastIndex((item) => isRecoveryMessageId(item.clientId));

  return string(turn.items.slice(inputIndex + 1).findLast((item) => item.type === "agentMessage")?.text).trim();
}

const sleepCommands = (state: Snapshot) =>
  state.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "commandExecution" && /\bsleep\s+30\b/.test(string(item.command))).length;

async function restart(target: Bridge) {
  target.close();
  await waitFor(target, (state) => state.connection === "disconnected", "old process to exit");
  const next = new Bridge();
  await next.ensureConnected();

  return next;
}

try {
  await bridge.ensureConnected();
  assert.equal(bridge.snapshot.turns.length, 0);
  assert.equal(bridge.snapshot.queue.length, 0);
  await bridge.send(
    crypto.randomUUID(),
    "Integration check: no subagents, delegated jobs or unfinished work exist. Reply exactly SETUP_OK now."
  );
  await waitFor(bridge, (state) => !state.activeTurnId && replies(state).includes("SETUP_OK"), "setup reply");
  bridge = await restart(bridge);
  await waitFor(
    bridge,
    (state) => !state.activeTurnId && recoveryInputs(state).length === 1 && !!recoveryReply(state),
    "startup recovery reply"
  );
  assert.equal(recoveryInputs(bridge.snapshot).length, 1);
  assert.equal(recoveryInputs(visibleSnapshot(bridge.snapshot)).length, 0);
  assert.equal(replies(visibleSnapshot(bridge.snapshot)).includes(recoveryReply(bridge.snapshot)), true);
  await bridge.ensureConnected();
  await bridge.ensureConnected();
  assert.equal(recoveryInputs(bridge.snapshot).length, 1);
  await bridge.send(
    crypto.randomUUID(),
    "Run the read-only shell command sleep 30 before responding. If Pocket restarts before it finishes, continue the interrupted work by confirming the restart instead of restarting sleep. Do not modify files or start other jobs."
  );
  await waitFor(
    bridge,
    (state) =>
      state.turns.some(
        (turn) => turn.id === state.activeTurnId && turn.items.some((item) => item.type === "commandExecution")
      ),
    "in-progress command"
  );
  const previousSleeps = sleepCommands(bridge.snapshot);
  const EXPECTED_RECOVERY_STARTS = 2;
  bridge = await restart(bridge);
  await waitFor(
    bridge,
    (state) =>
      !state.activeTurnId && recoveryInputs(state).length === EXPECTED_RECOVERY_STARTS && !!recoveryReply(state),
    "interrupted work recovery"
  );
  assert.equal(recoveryInputs(bridge.snapshot).length, EXPECTED_RECOVERY_STARTS);
  assert.equal(sleepCommands(bridge.snapshot), previousSleeps);
  assert.equal(recoveryInputs(visibleSnapshot(bridge.snapshot)).length, 0);
  assert.equal(replies(visibleSnapshot(bridge.snapshot)).includes(recoveryReply(bridge.snapshot)), true);
  console.info(
    "Real Codex recovery passed: empty start, resumed history, one hidden prompt per process, reconnect deduplication and interrupted work"
  );
} finally {
  bridge.close();
  const cleanup = new CodexRpc();

  try {
    await cleanup.connect(config);
    await cleanup.request("thread/archive", { threadId: thread.id });
  } finally {
    cleanup.close();
  }
}
