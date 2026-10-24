import { type Config, configSchema } from "../src/server/config";
import { type Snapshot, string } from "../src/lib/protocol";
import { Bridge } from "../src/server/bridge";
import { CodexRpc } from "../src/server/rpc";
import assert from "node:assert/strict";
import { isRecoveryMessageId } from "../src/server/recovery";
import { mkdir } from "node:fs/promises";
import nextEnv from "@next/env";
import path from "node:path";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const TURN_TIMEOUT_MS = 120_000;
const EXPECTED_RECOVERY_STARTS = 2;

/**
Waits on actual bridge snapshot notifications and removes the listener on every settled outcome.
@param target - Owned native bridge whose canonical state is inspected.
@param isSatisfied - Expected canonical state predicate.
@param label - Lifecycle stage included in timeout and native-error reports.
@returns Completion when the expected state arrives; native errors and timeout reject.
*/
function waitFor(target: Bridge, isSatisfied: (state: Snapshot) => boolean, label: string) {
  return new Promise<void>((resolve, reject) => {
    const pending: { timer?: NodeJS.Timeout } = {};

    function inspect() {
      if (!isSatisfied(target.snapshot) && !target.snapshot.error) {
        return;
      }

      clearTimeout(pending.timer);
      target.snapshots.removeEventListener("snapshot", inspect);

      if (isSatisfied(target.snapshot)) {
        resolve();
      } else {
        reject(new Error(`${label}: ${target.snapshot.error ?? "Unknown error"}`));
      }
    }

    pending.timer = setTimeout(() => {
      target.snapshots.removeEventListener("snapshot", inspect);
      reject(new Error(`Timed out waiting for ${label}`));
    }, TURN_TIMEOUT_MS);
    target.snapshots.addEventListener("snapshot", inspect);
    inspect();
  });
}

/**
Selects canonical native assistant text for the live recovery assertions.
@param state - Canonical or visible bridge snapshot.
@returns Assistant replies in native transcript order.
*/
function replies(state: Snapshot) {
  return state.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "agentMessage")
    .map((item) => string(item.text));
}

/**
Selects reserved recovery instructions without matching ordinary user text.
@param state - Canonical or visible bridge snapshot.
@returns Native user items carrying reserved recovery identities.
*/
function recoveryInputs(state: Snapshot) {
  return state.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "userMessage" && isRecoveryMessageId(item.clientId));
}

/**
Reads the completed assistant reply following the newest reserved recovery input.
@param state - Canonical bridge snapshot.
@returns Trimmed recovery reply, or empty text while recovery is incomplete.
*/
function recoveryReply(state: Snapshot) {
  const turn = state.turns.findLast((entry) => entry.items.some((item) => isRecoveryMessageId(item.clientId)));

  if (turn?.status === "completed") {
    const inputIndex = turn.items.findLastIndex((item) => isRecoveryMessageId(item.clientId));

    return string(turn.items.slice(inputIndex + 1).findLast((item) => item.type === "agentMessage")?.text).trim();
  }

  return "";
}

/**
Counts native sleep commands to detect accidental replay after an interrupted restart.
@param state - Canonical native bridge snapshot.
@returns Number of recorded sleep-30 command items.
*/
function sleepCommands(state: Snapshot) {
  return state.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "commandExecution" && /\bsleep\s+30\b/.test(string(item.command))).length;
}

/**
Owns the real check bridge across process restarts and final native archival.
*/
class RecoveryCheck {
  private bridge = new Bridge();

  /**
  Captures the bootstrap configuration and newly created test thread after its environment is installed.
  @param config - Native executable and private project configuration used for archival.
  @param threadId - Newly created live recovery-check thread identity.
  */
  constructor(
    private config: Config,
    private threadId: string
  ) {}

  /**
  Waits for confirmed disconnection before replacing the owned bridge process.
  @returns Completion of the replacement bridge's native connection.
  */
  private async restart() {
    this.bridge.close();
    await waitFor(this.bridge, (state) => state.connection === "disconnected", "old process to exit");
    this.bridge = new Bridge();
    await this.bridge.ensureConnected();
  }

  /**
  Confirms an empty initial thread and records the original completed setup message.
  @returns Completion of the native setup reply.
  */
  private async setup() {
    await this.bridge.ensureConnected();
    assert.equal(this.bridge.snapshot.turns.length, 0);
    assert.equal(this.bridge.snapshot.queue.length, 0);
    await this.bridge.send(
      crypto.randomUUID(),
      "Integration check: no subagents, delegated jobs or unfinished work exist. Reply exactly SETUP_OK now."
    );
    await waitFor(this.bridge, (state) => !state.activeTurnId && replies(state).includes("SETUP_OK"), "setup reply");
  }

  /**
  Confirms one hidden recovery instruction per new process and deduplication across reconnects.
  @returns Completion of startup recovery and reconnect assertions.
  */
  private async initialRecovery() {
    await this.restart();
    await waitFor(
      this.bridge,
      (state) => !state.activeTurnId && recoveryInputs(state).length === 1 && !!recoveryReply(state),
      "startup recovery reply"
    );
    assert.equal(recoveryInputs(this.bridge.snapshot).length, 1);
    assert.equal(recoveryInputs(visibleSnapshot(this.bridge.snapshot)).length, 0);
    assert.equal(replies(visibleSnapshot(this.bridge.snapshot)).includes(recoveryReply(this.bridge.snapshot)), true);
    await this.bridge.ensureConnected();
    await this.bridge.ensureConnected();
    assert.equal(recoveryInputs(this.bridge.snapshot).length, 1);
  }

  /**
  Starts the existing read-only sleep command and waits for its native in-progress item.
  @returns Completion once there is real interrupted work available for the restart check.
  */
  private async interruptedCommand() {
    await this.bridge.send(
      crypto.randomUUID(),
      "Run the read-only shell command sleep 30 before responding. If Pocket restarts before it finishes, continue the interrupted work by confirming the restart instead of restarting sleep. Do not modify files or start other jobs."
    );
    await waitFor(
      this.bridge,
      (state) =>
        state.turns.some(
          (turn) => turn.id === state.activeTurnId && turn.items.some((item) => item.type === "commandExecution")
        ),
      "in-progress command"
    );
  }

  /**
  Confirms interrupted native work recovers without replaying its original sleep command.
  @param previousSleeps - Command count captured immediately before replacing the native process.
  @returns Completion of hidden-input, visible-reply and non-replay assertions.
  */
  private async interruptedRecovery(previousSleeps: number) {
    await this.restart();
    await waitFor(
      this.bridge,
      (state) =>
        !state.activeTurnId && recoveryInputs(state).length === EXPECTED_RECOVERY_STARTS && !!recoveryReply(state),
      "interrupted work recovery"
    );
    assert.equal(recoveryInputs(this.bridge.snapshot).length, EXPECTED_RECOVERY_STARTS);
    assert.equal(sleepCommands(this.bridge.snapshot), previousSleeps);
    assert.equal(recoveryInputs(visibleSnapshot(this.bridge.snapshot)).length, 0);
    assert.equal(replies(visibleSnapshot(this.bridge.snapshot)).includes(recoveryReply(this.bridge.snapshot)), true);
  }

  /**
  Executes the original empty-start, resumed-history and interrupted-work scenarios in order.
  @returns Completion of the real recovery scenarios.
  */
  private async scenarios() {
    await this.setup();
    await this.initialRecovery();
    await this.interruptedCommand();
    await this.interruptedRecovery(sleepCommands(this.bridge.snapshot));
    console.info(
      "Real Codex recovery passed: empty start, resumed history, one hidden prompt per process, reconnect deduplication and interrupted work"
    );
  }

  /**
  Archives only this newly created check thread with a separately owned native connection.
  @returns Completion of archive acknowledgement and cleanup connection closure.
  */
  private async archive() {
    const cleanup = new CodexRpc();

    await cleanup
      .connect(this.config)
      .then(() => cleanup.request("thread/archive", { threadId: this.threadId }))
      .finally(() => {
        cleanup.close();
      });
  }

  /**
  Runs the explicitly selected live check and closes its current bridge on every outcome.
  @returns Completion of the live scenarios and native archival.
  */
  async run() {
    await this.scenarios().finally(async () => {
      this.bridge.close();
      await this.archive();
    });
  }
}

/**
Creates and names a real native check thread on the connected bootstrap transport.
@param rpc - Owned connected native transport.
@param config - Native executable and private working-folder configuration.
@returns Newly created thread identity.
*/
async function createThread(rpc: CodexRpc, config: Config) {
  const { thread } = await rpc.request("thread/start", {
    cwd: config.cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: false,
  });

  await rpc.request("thread/name/set", { threadId: thread.id, name: "Pocket restart recovery integration check" });

  return thread.id;
}

/**
Owns the bootstrap transport until the real test thread is created and named.
@param config - Native executable and private working-folder configuration.
@returns Newly created thread identity after bootstrap transport closure.
*/
async function startThread(config: Config) {
  const rpc = new CodexRpc();

  return rpc
    .connect(config)
    .then(() => createThread(rpc, config))
    .finally(() => {
      rpc.close();
    });
}

/**
Installs the new test thread's environment before constructing its actual bridge resource.
@param project - Fresh private native working folder.
@returns Completion of the real recovery check and archival.
*/
async function configuredBridge(project: string) {
  const config = configSchema.parse({
    threadId: "bootstrap",
    cwd: project,
    codexBinary: process.env.CODEX_BINARY ?? "codex",
  });
  const threadId = await startThread(config);

  process.env.CODEX_THREAD_ID = threadId;
  process.env.CODEX_CWD = project;
  process.env.CODEX_SERVER_ARGS = '["app-server","--listen","stdio://"]';
  await new RecoveryCheck(config, threadId).run();
}

/**
Creates private native state before starting the explicitly requested live recovery check.
@returns Completion of private setup and the native recovery lifecycle.
*/
async function main() {
  const directory = path.resolve(".local", "recovery-check", crypto.randomUUID());
  const project = path.join(directory, "project");

  await mkdir(project, { recursive: true });
  process.env.CODEX_POCKET_STATE_DIR = directory;
  await configuredBridge(project);
}

nextEnv.loadEnvConfig(process.cwd());
await main();
