import { type Config } from "../../src/server/config";
import { type CodexRpc } from "../../src/server/rpc";
import { Bridge } from "../../src/server/bridge-session";
import { readFile, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { requestFile } from "../../src/server/request-files";
import { eventually, type workspace } from "./workflow";
import path from "node:path";
import { t as attempt } from "try";

/** Inspect the final atomic prompt replacement, allowing only a not-yet-created file.
@param filename - Private pending-prompt file.
@param previous - Inode before native disconnect.
@returns Whether the replacement contains the expected empty prompt list.
*/
async function isPromptCleared(filename: string, previous: number | undefined) {
  const outcome = await attempt(() => stat(filename));

  if (!outcome.ok) {
    const error = outcome.error;

    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  const content = await readFile(filename, "utf8");

  return outcome.value.ino !== previous && content.trim() === "[]";
}

/**
Join native exit and its final atomic prompt write before disposing private workflow state.
*/
class WorkflowBridge extends Bridge {
  private readers = new Set<CodexRpc>();
  private writes: Promise<void>[] = [];
  private failures: unknown[] = [];

  /** Bind the fixture's private directory without changing production bridge behavior.
  @param directory - Owned workflow state directory.
  @param config - Explicit native launch configuration.
  */
  constructor(
    private directory: string,
    config: Config
  ) {
    super(config);
  }

  /** Observe the replacement file rather than sleeping through pending filesystem work.
  @param filename - Parent's durable pending-prompt file.
  @param previous - Inode before the disconnect handler's atomic replacement.
  */
  private async promptCleanup(filename: string, previous: number | undefined) {
    const completed = await attempt(
      eventually(() => isPromptCleared(filename, previous), "Native disconnect must finish prompt cleanup")
    );

    if (completed.ok) {
      return;
    }

    const error = completed.error;

    this.failures.push(error);
  }

  /**
  Observe each real connection before its owner can close or disconnect it.
  */
  override async ensureConnected() {
    await super.ensureConnected();
    const reader = this.agentReader();

    if (this.readers.has(reader)) {
      return;
    }

    this.readers.add(reader);
    reader.addEventListener(
      "disconnect",
      () => {
        const filename = path.join(this.directory, requestFile(this.snapshot.threadId));

        let previous: number | undefined;

        const outcome1 = attempt(() => {
          previous = statSync(filename).ino;
        });

        if (!outcome1.ok) {
          const error = outcome1.error;

          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            this.failures.push(error);

            return;
          }
        }

        this.writes.push(this.promptCleanup(filename, previous));
      },
      { once: true }
    );
  }

  /**
  Stop owned processes, then join serialized work and the observed final persistence write.
  */
  async shutdown() {
    this.close();
    await Promise.all([...this.readers].map((reader) => reader.shutdown()));
    await this.exclusive(() => Promise.resolve());
    await Promise.all(this.writes);
    this.snapshots.close();

    if (this.failures.length > 0) {
      throw new AggregateError(this.failures, "Bridge fixture shutdown failed");
    }
  }
}

/** Register a real bridge whose asynchronous native shutdown belongs to this workflow.
@param fixture - Private workflow state and cleanup owner.
@param config - Native launch configuration.
@returns Production bridge with a fixture-only resource joining operation.
*/
export function workflowBridge(fixture: Awaited<ReturnType<typeof workspace>>, config: Config) {
  const bridge = new WorkflowBridge(fixture.directory, config);

  fixture.cleanup(() => bridge.shutdown());

  return bridge;
}
