import { t } from "try";
import type { DelegationCommand, DelegationStore, SidePocket } from "./delegations";
import type { HarnessAdapter, HarnessResult } from "./harness/types";
import { log } from "./logging";
import { sessionAttachment } from "./session-adoption";
import { internalContext } from "./internal-context";

/**
Owns one claimed command from native session opening through confirmed process cleanup.
*/
export class DelegationRun {
  private isSending = false;

  private ready = Promise.withResolvers<boolean>();

  private settled = false;

  private deliveries = new Map<string, Promise<void>>();
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
    readonly command: DelegationCommand,
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
      !isClosing && (!this.store.mail.hasResult(child.id, command.id, result.text) || result.status !== "completed");
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
    await this.runTurn();
  }

  /**
  Dispatch observation receipts only to watch-capable adapters; never turn them into prompts.
  @returns The native assignment or the existing turn's observed result.
  */
  private startCommand() {
    const attachment = sessionAttachment(this.child.metadata);

    if (attachment?.watchCommandId !== this.command.id) {
      return this.adapter.run(this.command.id, this.input(this.command));
    }

    return attachment.turnId && this.adapter.watch
      ? this.adapter.watch(attachment.turnId)
      : Promise.reject(new Error("This adapter cannot observe the existing turn. Nothing was sent."));
  }

  /**
  Attribute assignments and steering to their parent without claiming human authorship or delivery.
  @param command - Original durable parent command, unchanged for retries and inspection.
  @returns Model-facing internal handoff with the complete assignment.
  */
  private input(command: DelegationCommand) {
    return internalContext(`parent_pocket:${this.child.parentId}:command:${command.id}`, command.body);
  }

  /**
  Publish readiness after the native assignment starts and fence completion against active deliveries.
  */
  private async runTurn() {
    const result = this.startCommand();

    this.ready.resolve(true);

    const response = await t(result);

    this.settled = true;
    const finished = response.ok ? await t(() => this.finishDelivery(response.value)) : response;

    this.ready.resolve(false);

    if (!finished.ok) {
      throw finished.error;
    }
  }

  /** Fence native completion against in-flight steering receipts.
  @param outcome - Completed native assignment.
  */
  private async finishDelivery(outcome: HarnessResult) {
    await Promise.all(this.deliveries.values());
    this.complete(outcome);
  }

  /**
  Confirms process exit or records uncertainty so the worker retains the occupied slot.
  @returns Completion of native cleanup and its durable outcome.
  */
  private async close() {
    const closed = await t(() => this.adapter.close());

    this.exitStatus = closed.ok ? "confirmed" : "uncertain";

    if (closed.ok) {
      return;
    }

    this.store.setStatus(this.child.parentId, this.child.id, "unknown");
    log().error({ error: closed.error, childId: this.child.id }, "side_pocket.cleanup_failed");
  }

  /**
  Deliver a correction only while this exact assignment still owns an active native turn.
  @param command - Claimed correction with a stable native message identity.
  */
  private async deliverCurrent(command: DelegationCommand) {
    const isReady = await this.ready.promise;
    const result =
      isReady && !this.settled
        ? await this.adapter.steer(command.id, this.input(command))
        : { status: "idle" as const, detail: "The owned assignment ended before native delivery. Nothing was sent." };

    this.store.queue.steering.finish(command, result);
  }

  /**
  Retain uncertain native attempts and release the completion fence after persistence.
  @param command - Correction acquired by this run's worker.
  */
  private async deliver(command: DelegationCommand) {
    const delivered = await t(() => this.deliverCurrent(command));
    const recorded = delivered.ok
      ? delivered
      : t(() => {
          this.store.queue.steering.finish(command, {
            status: "unknown",
            detail: delivered.error instanceof Error ? delivered.error.message : String(delivered.error),
          });
        });

    this.deliveries.delete(command.id);

    if (!recorded.ok) {
      throw recorded.error;
    }
  }

  /**
  Register correction delivery before native completion can release this assignment's process.
  @param command - Correction already marked attempted in the durable ledger.
  */
  steer(command: DelegationCommand) {
    this.deliveries.set(command.id, this.deliver(command));
  }

  /**
  Runs the command with durable failure recording and unconditional native cleanup.
  @returns Completion of execution and cleanup; persistence failures can reject.
  */
  async execute() {
    const sent = await t(() => this.send());
    const recorded = sent.ok
      ? sent
      : t(() => {
          this.failed(sent.error);
        });

    this.settled = true;
    this.ready.resolve(false);
    await Promise.all(this.deliveries.values());
    await this.close();

    if (!recorded.ok) {
      throw recorded.error;
    }
  }
}
