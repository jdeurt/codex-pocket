import { type DelegationCommand, type DelegationStore, MAX_CONCURRENT_CHILDREN, type SidePocket } from "./delegations";
import { type HarnessAdapter, type HarnessRequest, type HarnessResult } from "./harness/types";
import { type Config } from "./config";
import { createAdapter } from "./harness";
import { localDirectory } from "./local-state";
import { log } from "./logging";
import { object } from "../lib/protocol";
import path from "node:path";
import { z } from "zod";

const RECOVERY_INTERVAL_MS = 30_000;

interface WorkerOptions {
  createAdapter?: (harness: SidePocket["harness"], options: Parameters<typeof createAdapter>[1]) => HarnessAdapter;
  recoveryIntervalMs?: number;
}
interface ParentDelivery {
  send: (id: string, text: string) => Promise<{ status: string }>;
}
interface WaitingRequest {
  childId: string;
  resolve: (answer: unknown) => void;
  reject: (error: Error) => void;
}

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

export class DelegationWorker {
  private timer?: NodeJS.Timeout;

  private unsubscribe?: () => void;

  private ticking?: Promise<void>;

  private forwarding?: Promise<void>;

  private dirty = false;

  private mailDirty = false;

  private started = false;

  private stopped = false;

  private active = new Map<string, { adapter: HarnessAdapter; done: Promise<void> }>();

  private closing = new Map<string, Promise<void>>();

  private waiting = new Map<string, WaitingRequest>();

  constructor(
    private store: DelegationStore,
    private parent: ParentDelivery,
    private config: Config,
    private options: WorkerOptions = {}
  ) {}

  private request(child: SidePocket, request: HarnessRequest) {
    const id = this.store.mail.request(child.parentId, child.id, request);

    this.store.setStatus(child.parentId, child.id, "waiting");

    return new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { childId: child.id, resolve, reject });
    });
  }

  private answers() {
    for (const child of this.store.list(this.config.threadId)) {
      for (const request of this.store.mail.requests(child.parentId, child.id)) {
        const waiting = this.waiting.get(request.id);

        if (!waiting || request.status === "pending") {
          continue;
        }

        this.waiting.delete(request.id);

        if (
          request.status === "answered" &&
          request.answer !== null &&
          this.store.continueChild(child.parentId, child.id)
        ) {
          waiting.resolve(JSON.parse(request.answer));
        } else {
          waiting.reject(new Error("Side Pocket request was cancelled."));
        }
      }
    }
  }

  private complete(child: SidePocket, command: DelegationCommand, result: HarnessResult) {
    const isClosing = this.store.get(child.parentId, child.id).status === "closing";
    const shouldNotify =
      !isClosing && (!this.store.mail.hasMessage(child.id, command.id) || result.status !== "completed");

    this.store.recordResult(
      command,
      isClosing ? "cancelled" : result.status === "failed" ? "failed" : "completed",
      JSON.stringify(result),
      shouldNotify ? { sourceId: `result:${command.id}`, kind: "completion", payload: result } : undefined
    );
    log().info({ childId: child.id, commandId: command.id, result, closing: isClosing }, "side_pocket.completed");
  }

  private async execute(child: SidePocket, command: DelegationCommand, adapter: HarnessAdapter) {
    // Reserve the active slot before even a synchronous adapter can finish.
    await Promise.resolve();
    let isSending = false;

    try {
      const sessionId = await adapter.open();

      this.store.setSession(child.parentId, child.id, sessionId);
      log().info(
        { childId: child.id, parentId: child.parentId, harness: child.harness, sessionId, commandId: command.id },
        "side_pocket.started"
      );

      if (this.store.get(child.parentId, child.id).status === "closing") {
        this.store.finish(command, "cancelled", "Closed before sending.");

        return;
      }

      isSending = true;
      const result = await adapter.run(command.id, command.body);

      this.complete(child, command, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isClosing = this.store.get(child.parentId, child.id).status === "closing";

      this.store.recordResult(
        command,
        isClosing ? "cancelled" : isSending ? "unknown" : "failed",
        message,
        isClosing
          ? undefined
          : { sourceId: `error:${command.id}`, kind: "failure", payload: { message, commandId: command.id } }
      );

      log().error({ error, childId: child.id, commandId: command.id }, "side_pocket.failed");
    } finally {
      try {
        await adapter.close();
        this.active.delete(child.id);
      } catch (error) {
        // Keep the slot occupied until process exit can be confirmed.
        this.store.setStatus(child.parentId, child.id, "unknown");
        log().error({ error, childId: child.id }, "side_pocket.cleanup_failed");
      }

      this.store.mail.cancelRequests(child.id);
      void this.tick();
    }
  }

  private launch(child: SidePocket, command: DelegationCommand) {
    const policy = this.store.parent(child.parentId).policy;
    const { sessionStarted } = object(JSON.parse(child.metadata));
    const adapter = (this.options.createAdapter ?? createAdapter)(child.harness, {
      config: this.config,
      child: { ...child, policy, ...(typeof sessionStarted === "boolean" && { sessionStarted }) },
      parentTools: parentToolServer(child.id, command.id),
      callbacks: {
        request: (request) => this.request(child, request),
        output: (text) =>
          this.store.mail.record(child.parentId, child.id, `output:${crypto.randomUUID()}`, "output", { text }, false),
        metadata: (data) => {
          this.store.metadata(child.parentId, child.id, data);
        },
      },
    });
    const done = this.execute(child, command, adapter);

    this.active.set(child.id, { adapter, done });
  }

  private async closeRequested(child: SidePocket) {
    const running = this.active.get(child.id);

    try {
      await running?.adapter.interrupt();
    } finally {
      await running?.adapter.close();
    }

    await running?.done;
    this.active.delete(child.id);
    this.store.setStatus(child.parentId, child.id, "closed");
    log().info({ childId: child.id, sessionId: child.sessionId }, "side_pocket.closed");
  }

  private async forward() {
    for (const mail of this.store.mail.pending(this.config.threadId)) {
      const child = this.store.get(mail.parentId, mail.childId);
      const text = `Side Pocket ${JSON.stringify(child.title)} (${child.harness}, ID ${child.id}) sent ${mail.kind}.
This is a report from your delegate. Interpret its contents in the context of the work you assigned.
${mail.payload}`;
      const receipt = await this.parent.send(mail.id, text);

      const delivery = z.enum(["queued", "sent", "unknown"]).safeParse(receipt.status);

      if (delivery.success) {
        this.store.mail.delivered(mail.id, delivery.data);
      }
    }
  }

  private async forwardPending() {
    await Promise.resolve();

    try {
      while (this.mailDirty && !this.stopped) {
        this.mailDirty = false;

        try {
          await this.forward();
        } catch (error) {
          log().error({ error }, "side_pocket.forward_failed");
        }
      }
    } finally {
      this.forwarding = undefined;

      if (this.mailDirty && !this.stopped) {
        this.forwardSoon();
      }
    }
  }

  private forwardSoon() {
    this.mailDirty = true;
    this.forwarding ??= this.forwardPending();
  }

  private async closeSafely(child: SidePocket) {
    try {
      await this.closeRequested(child);
    } catch (error) {
      log().error({ error, childId: child.id }, "side_pocket.close_failed");
    } finally {
      this.closing.delete(child.id);
    }
  }

  private dispatch() {
    for (const child of this.store.list(this.config.threadId)) {
      if (child.status !== "closing" || this.closing.has(child.id)) {
        continue;
      }

      const closing = this.closeSafely(child);

      this.closing.set(child.id, closing);
    }

    for (const child of this.store.queuedChildren(this.config.threadId)) {
      if (this.active.size >= MAX_CONCURRENT_CHILDREN) {
        break;
      }

      if (this.active.has(child.id) || this.closing.has(child.id)) {
        continue;
      }

      const command = this.store.claim(child.parentId, child.id);

      if (command) {
        this.launch(child, command);
      }
    }
  }

  private async drain() {
    await Promise.resolve();

    try {
      while (this.dirty && !this.stopped) {
        this.dirty = false;

        try {
          this.answers();
          this.dispatch();
          this.forwardSoon();
        } catch (error) {
          log().error({ error }, "side_pocket.worker_failed");
        }
      }
    } finally {
      this.ticking = undefined;

      if (this.dirty && !this.stopped) {
        void this.tick();
      }
    }
  }

  async tick() {
    if (this.stopped) {
      return;
    }

    this.dirty = true;
    this.ticking ??= this.drain();
    await this.ticking;
  }

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

  async stop() {
    this.stopped = true;
    this.unsubscribe?.();
    clearInterval(this.timer);

    for (const waiting of this.waiting.values()) {
      waiting.reject(new Error("Pocket is stopping; this request can be continued in the saved session."));
    }

    this.waiting.clear();
    await this.ticking;
    const running = this.active.values().toArray();

    for (const entry of running) {
      await entry.adapter.close();
    }

    await Promise.allSettled(running.map((entry) => entry.done));
    await Promise.allSettled(this.closing.values());
    await this.forwarding;
  }
}
