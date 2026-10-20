import { type ChildProcess, fork } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { snapshotSchema } from "../../src/lib/protocol";
import { z } from "zod";

const PROCESS_TIMEOUT_MS = 15_000;
const THREAD_ID = "isolated-restart-check";
const replySchema = z.union([
  z.object({ raw: snapshotSchema, visible: snapshotSchema, error: z.undefined().optional() }),
  z.object({ error: z.string() }),
]);

/** Locate restart evidence in this fixture parent's isolated namespace.
@param directory - Private state root.
@returns Parent-specific durable restart file.
*/
export const restartFile = (directory: string) => path.join(directory, "restarts", `${THREAD_ID}.json`);

/**
Starts one private bridge worker with the offline native replay executable.
@param directory - Private native history, bridge state and logs directory.
@returns Owned child process with stdout drained and diagnostics forwarded.
*/
function startWorker(directory: string) {
  const target = fork(path.resolve("tests/fixtures/restart-worker.ts"), [], {
    env: {
      ...process.env,
      CODEX_THREAD_ID: THREAD_ID,
      CODEX_CWD: directory,
      CODEX_POCKET_STATE_DIR: directory,
      CODEX_BINARY: process.execPath,
      CODEX_SERVER_ARGS: JSON.stringify(["--import", "tsx", path.resolve("tests/fixtures/restart-rpc.ts")]),
    },
    execArgv: ["--import", "tsx"],
    silent: true,
  });

  target.stdout?.resume();
  target.stderr?.pipe(process.stderr);

  return target;
}

/**
Validates the child IPC reply at the sole transport boundary.
@param reply - Pending native IPC message tuple.
@returns Normalized snapshot pair or explicit worker failure.
*/
async function receivedReply(reply: Promise<unknown[]>) {
  const replies = await reply;

  return replySchema.parse(replies[0]);
}

/**
Owns the fake bridge child across explicit restart and recovery workflow phases.
*/
export class RestartHost {
  private child: ChildProcess;

  /**
  Starts the initial private bridge process.
  @param directory - Private native history and bridge state root.
  */
  constructor(private directory: string) {
    this.child = startWorker(directory);
  }

  /**
  Reports whether the owned child has yet to confirm exit or termination.
  @returns Whether shutdown must still be joined.
  */
  get isRunning() {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /**
  Starts a replacement worker only after the previous native process has exited.
  @param directory - Optional alternate private state directory for failure scenarios.
  */
  start(directory = this.directory) {
    if (this.isRunning) {
      throw new Error("Stop the owned restart worker before replacing it.");
    }

    this.child = startWorker(directory);
  }

  /**
  Sends one IPC command and waits for its validated native response.
  @param text - Optional user message to send through the real bridge.
  @returns Snapshot pair or explicit worker error, bounded by the IPC timeout.
  */
  async request(text?: string) {
    const reply = once(this.child, "message", { signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS) });

    this.child.send({ id: crypto.randomUUID(), text });

    return await receivedReply(reply);
  }

  /**
  Requires a successful IPC snapshot pair for a normal workflow stage.
  @param text - Optional user message sent before taking the snapshot.
  @returns Canonical and phone snapshots; an explicit worker failure throws.
  */
  async snapshot(text?: string) {
    const result = await this.request(text);

    assert.equal(result.error, undefined);
    assert.ok("raw" in result && "visible" in result);

    return result;
  }

  /**
  Terminates the owned bridge and waits for its actual native process exit.
  @returns Completion of child shutdown, bounded by the IPC timeout.
  */
  async stop() {
    const exited = once(this.child, "exit", { signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS) });

    this.child.kill("SIGTERM");
    await exited;
  }
}
