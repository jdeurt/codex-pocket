import type { DelegationCommand, DelegationStore, SidePocket } from "./delegations";
import type { HarnessAdapter, HarnessResult } from "./harness/types";
import { log } from "./logging";

/**
Owns one claimed command from native session opening through confirmed process cleanup.
*/
export class DelegationRun {
  private isSending = false;
  exitStatus?: "confirmed" | "uncertain";

  /**
  Binds a durable command to the adapter that will execute it.
  @param store - Durable delegation owner.
  @param child - Claimed child identity and saved session.
  @param command - Persisted command claimed for this child.
  @param adapter - Native process resource retained until cleanup is confirmed.
  */
  constructor(
    private store: DelegationStore,
    private child: SidePocket,
    private command: DelegationCommand,
    readonly adapter: HarnessAdapter
  ) {}

  /**
  Persists a terminal result, suppressing duplicate completion mail and respecting cancellation.
  @param result - Native harness outcome.
  */
  private complete(result: HarnessResult) {
    const { child, command } = this;
    const isClosing = this.store.get(child.parentId, child.id).status === "closing";
    const shouldNotify =
      !isClosing && (!this.store.mail.hasMessage(child.id, command.id) || result.status !== "completed");
    const status = result.status === "failed" ? "failed" : "completed";

    this.store.queue.recordResult(
      command,
      isClosing ? "cancelled" : status,
      JSON.stringify(result),
      shouldNotify ? { sourceId: `result:${command.id}`, kind: "completion", payload: result } : undefined
    );
    log().info({ childId: child.id, commandId: command.id, result, closing: isClosing }, "side_pocket.completed");
  }

  /**
  Records pre-send failures separately from uncertain attempted sends.
  @param error - Failure raised while opening or executing the native session.
  */
  private failed(error: unknown) {
    const { child, command } = this;
    const message = error instanceof Error ? error.message : String(error);
    const isClosing = this.store.get(child.parentId, child.id).status === "closing";
    const status = this.isSending ? "unknown" : "failed";

    this.store.queue.recordResult(
      command,
      isClosing ? "cancelled" : status,
      message,
      isClosing
        ? undefined
        : { sourceId: `error:${command.id}`, kind: "failure", payload: { message, commandId: command.id } }
    );
    log().error({ error, childId: child.id, commandId: command.id }, "side_pocket.failed");
  }

  /**
  Opens the saved session and checks cancellation before attempting the command.
  @returns Completion of command execution and result persistence.
  */
  private async send() {
    const { child, command, adapter } = this;
    const sessionId = await adapter.open();

    this.store.setSession(child.parentId, child.id, sessionId);
    log().info(
      { childId: child.id, parentId: child.parentId, harness: child.harness, sessionId, commandId: command.id },
      "side_pocket.started"
    );

    if (this.store.get(child.parentId, child.id).status === "closing") {
      this.store.queue.finish(command, "cancelled", "Closed before sending.");

      return;
    }

    this.isSending = true;
    this.complete(await adapter.run(command.id, command.body));
  }

  /**
  Confirms process exit or records uncertainty so the worker retains the occupied slot.
  @returns Completion of native cleanup and its durable outcome.
  */
  private async close() {
    try {
      await this.adapter.close();
      this.exitStatus = "confirmed";
    } catch (error) {
      this.store.setStatus(this.child.parentId, this.child.id, "unknown");
      log().error({ error, childId: this.child.id }, "side_pocket.cleanup_failed");
      this.exitStatus = "uncertain";
    }
  }

  /**
  Runs the command with durable failure recording and unconditional native cleanup.
  @returns Completion of execution and cleanup; persistence failures can reject.
  */
  async execute() {
    try {
      await this.send();
    } catch (error) {
      this.failed(error);
    } finally {
      await this.close();
    }
  }
}
