import { type DelegationCommand, type DelegationStore, MAX_CONCURRENT_CHILDREN, type SidePocket } from "./delegations";
import { type ParentDelivery, ParentReports } from "./delegation-reports";
import { type Config } from "./config";
import { DelegationQuestions } from "./delegation-questions";
import { DelegationRun } from "./delegation-run";
import { type HarnessAdapter } from "./harness/types";
import { createAdapter } from "./harness";
import { localDirectory } from "./local-state";
import { log } from "./logging";
import { object } from "../lib/protocol";
import path from "node:path";

const RECOVERY_INTERVAL_MS = 30_000;

interface WorkerOptions {
  createAdapter?: (harness: SidePocket["harness"], options: Parameters<typeof createAdapter>[1]) => HarnessAdapter;
  recoveryIntervalMs?: number;
}

/**
Builds the scoped native MCP command used by one delegated assignment.
@param childId - Child identity used to authorize parent tools.
@param commandId - Claimed command whose requests and reports are attributed.
@returns Native stdio command and narrowly scoped environment.
*/
export function parentToolServer(childId: string, commandId: string) {
  return {
    command: process.execPath,
    args: [
      "--import",
      path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
      path.join(process.cwd(), "scripts/side-pocket-mcp.ts"),
    ],
    env: { CODEX_POCKET_STATE_DIR: localDirectory(), POCKET_CHILD_ID: childId, POCKET_COMMAND_ID: commandId },
  };
}

/**
Coordinates durable child work, eight process slots, request answers and shutdown.
*/
export class DelegationWorker {
  private timer?: NodeJS.Timeout;

  private unsubscribe?: () => void;

  private ticking?: Promise<void>;

  private reports: ParentReports;

  private dirty = false;

  private started = false;

  private stopped = false;

  private active = new Map<string, { run: DelegationRun; done: Promise<void> }>();

  private closing = new Map<string, Promise<void>>();

  private questions: DelegationQuestions;

  /**
  Binds one worker to its durable queue and native harness adapters.
  @param store - Durable queue, child and mailbox owner.
  @param parent - Parent report transport, isolated from dispatch.
  @param config - Shared runtime configuration and parent identity.
  @param options - Optional adapter injection and reconciliation interval.
  */
  constructor(
    private store: DelegationStore,
    parent: ParentDelivery,
    private config: Config,
    private options: WorkerOptions = {}
  ) {
    this.reports = new ParentReports(store, parent, config);
    this.questions = new DelegationQuestions(store, config);
  }

  /**
  Releases only confirmed process slots before cancelling stale questions and waking dispatch.
  @param child - Child whose command settled.
  @param run - Native resource carrying its cleanup outcome.
  */
  private finishRun(child: SidePocket, run: DelegationRun) {
    if (run.exitStatus === undefined) {
      return;
    }

    if (run.exitStatus === "confirmed") {
      this.active.delete(child.id);
    }

    this.store.mail.cancelRequests(child.id);
    void this.tick();
  }

  /**
  Reserves the active slot before execution and reconciles cleanup even on failure.
  @param child - Child occupying the slot.
  @param run - Claimed command and native resource.
  @returns Completion of execution and slot reconciliation.
  */
  private async execute(child: SidePocket, run: DelegationRun) {
    // Reserve the active slot before even a synchronous adapter can finish.
    await Promise.resolve();

    try {
      await run.execute();
    } finally {
      this.finishRun(child, run);
    }
  }

  /**
  Creates the scoped native adapter and reserves its claimed command in the active registry.
  @param child - Queued child with parent policy and saved metadata.
  @param command - Atomically claimed durable command.
  */
  private launch(child: SidePocket, command: DelegationCommand) {
    const policy = this.store.parent(child.parentId).policy;
    const { sessionStarted } = object(JSON.parse(child.metadata));
    const adapter = (this.options.createAdapter ?? createAdapter)(child.harness, {
      config: this.config,
      child: { ...child, policy, ...(typeof sessionStarted === "boolean" && { sessionStarted }) },
      parentTools: parentToolServer(child.id, command.id),
      callbacks: {
        request: (request) => this.questions.request(child, request),
        output: (text) =>
          this.store.mail.record(child.parentId, child.id, `output:${crypto.randomUUID()}`, "output", { text }, false),
        metadata: (data) => {
          this.store.metadata(child.parentId, child.id, data);
        },
      },
    });
    const run = new DelegationRun(this.store, child, command, adapter);
    const done = this.execute(child, run);

    this.active.set(child.id, { run, done });
    void this.tick();
  }

  /**
  Interrupts a running child, confirms native close and joins its command.
  @param running - Active native resource and execution promise.
  @returns Confirmed close and execution completion; adapter failures reject.
  */
  private async closeActive(running: { run: DelegationRun; done: Promise<void> }) {
    try {
      await running.run.adapter.interrupt();
    } finally {
      await running.run.adapter.close();
    }

    await running.done;
  }

  /**
  Completes a requested child closure after any active native process settles.
  @param child - Child whose durable status requests closure.
  @returns Completion of native close and durable closed status.
  */
  private async closeRequested(child: SidePocket) {
    const running = this.active.get(child.id);

    if (running) {
      await this.closeActive(running);
    }

    this.active.delete(child.id);
    this.store.setStatus(child.parentId, child.id, "closed");
    log().info({ childId: child.id, sessionId: child.sessionId }, "side_pocket.closed");
  }

  /**
  Logs closure failures and always releases the in-progress closure marker.
  @param child - Child whose closure is being coordinated.
  @returns Completion of this closure attempt.
  */
  private async closeSafely(child: SidePocket) {
    try {
      await this.closeRequested(child);
    } catch (error) {
      log().error({ error, childId: child.id }, "side_pocket.close_failed");
    } finally {
      this.closing.delete(child.id);
    }
  }

  /**
  Closes requested children and claims queued work only when process capacity is available.
  */
  private dispatch() {
    for (const command of this.store.queue.steering.pending(this.config.threadId)) {
      const running = this.active.get(command.childId);

      if (running?.run.command.id === command.targetId && this.store.queue.steering.claim(command)) {
        running.run.steer(command);
      }
    }

    for (const child of this.store.list(this.config.threadId)) {
      if (child.status !== "closing" || this.closing.has(child.id)) {
        continue;
      }

      this.closing.set(child.id, this.closeSafely(child));
    }

    for (const child of this.store.queue.queuedChildren(this.config.threadId)) {
      if (this.active.size >= MAX_CONCURRENT_CHILDREN) {
        break;
      }

      if (this.active.has(child.id) || this.closing.has(child.id)) {
        continue;
      }

      this.claim(child);
    }
  }

  /**
  Atomically claims the next command before launching its native resource.
  @param child - Eligible queued child with an available process slot.
  */
  private claim(child: SidePocket) {
    const command = this.store.queue.claim(child.parentId, child.id);

    if (command) {
      this.launch(child, command);
    }
  }

  /**
  Processes synchronous queue wakeups without waiting for parent report delivery.
  */
  private flush() {
    while (this.dirty && !this.stopped) {
      this.dirty = false;

      try {
        this.questions.answers();
        this.dispatch();
        this.reports.queue();
      } catch (error) {
        log().error({ error }, "side_pocket.worker_failed");
      }
    }
  }

  /**
  Reserves a dispatch promise before work and preserves wakeups received during cleanup.
  @returns Completion of this dispatch drain.
  */
  private async drain() {
    await Promise.resolve();

    try {
      this.flush();
    } finally {
      this.ticking = undefined;

      if (this.dirty && !this.stopped) {
        void this.tick();
      }
    }
  }

  /**
  Closes the active-process snapshot after dispatch stops, then joins executions and closures.
  @returns Completion of native process and closure settlement.
  */
  private async closeAll() {
    const running = this.active.values().toArray();

    for (const entry of running) {
      await entry.run.adapter.close();
    }

    await Promise.allSettled(running.map((entry) => entry.done));
    await Promise.allSettled(this.closing.values());
  }

  /**
  Coalesces a queue wakeup into the current dispatch drain.
  @returns Completion of pending dispatch work, or immediate completion after stop.
  */
  async tick() {
    if (this.stopped) {
      return;
    }

    this.dirty = true;
    this.ticking ??= this.drain();
    await this.ticking;
  }

  /**
  Recovers persisted work, subscribes to commit wakeups and starts bounded reconciliation once.
  */
  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.unsubscribe = this.store.subscribe(() => void this.tick());
    this.store.recover(this.config.threadId);
    // fs.watch can lose events, and a writer can crash after commit but before
    // publishing. This bounded reconciliation also retries parent delivery.
    this.timer = setInterval(() => void this.tick(), this.options.recoveryIntervalMs ?? RECOVERY_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  /**
  Stops wakeups, rejects pending questions and joins native processes and parent delivery.
  @returns Completion of worker shutdown; native close failures reject.
  */
  async stop() {
    this.stopped = true;
    this.reports.stop();
    this.unsubscribe?.();
    clearInterval(this.timer);

    this.questions.stop();
    await this.ticking;
    await this.closeAll();
    await this.reports.settled();
  }
}
