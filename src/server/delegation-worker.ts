import type { DelegationCommand, DelegationStore, SidePocket } from "./delegations";
import type { HarnessAdapter, HarnessRequest, HarnessResult } from "./harness/types";
import type { Config } from "./config";
import { createAdapter } from "./harness";
import { localDirectory } from "./local-state";
import { log } from "./logging";
import { object } from "../lib/protocol";
import path from "node:path";

const POLL_INTERVAL_MS = 500;
const MAX_CONCURRENT_CHILDREN = 4;
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
  private ticking = false;
  private stopped = false;
  private active = new Map<string, { adapter: HarnessAdapter; done: Promise<void> }>();
  private waiting = new Map<string, WaitingRequest>();
  constructor(
    private store: DelegationStore,
    private parent: ParentDelivery,
    private config: Config
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

        if (request.status === "answered") {
          this.store.setStatus(child.parentId, child.id, "running");
          waiting.resolve(JSON.parse(request.answer as string));
        } else {
          waiting.reject(new Error("Side Pocket request was cancelled."));
        }
      }
    }
  }
  private complete(child: SidePocket, command: DelegationCommand, result: HarnessResult) {
    const closing = this.store.get(child.parentId, child.id).status === "closing";
    const notify = !closing && (!this.store.mail.hasMessage(child.id, command.id) || result.status !== "completed");
    this.store.recordResult(
      command,
      closing ? "cancelled" : result.status === "failed" ? "failed" : "completed",
      JSON.stringify(result),
      notify ? { sourceId: `result:${command.id}`, kind: "completion", payload: result } : undefined
    );
    log().info({ childId: child.id, commandId: command.id, result, closing }, "side_pocket.completed");
  }
  private async execute(child: SidePocket, command: DelegationCommand, adapter: HarnessAdapter) {
    let sending = false;

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

      sending = true;
      const result = await adapter.run(command.id, command.body);
      this.complete(child, command, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const closing = this.store.get(child.parentId, child.id).status === "closing";
      this.store.recordResult(
        command,
        closing ? "cancelled" : sending ? "unknown" : "failed",
        message,
        closing
          ? undefined
          : { sourceId: `error:${command.id}`, kind: "failure", payload: { message, commandId: command.id } }
      );

      log().error({ error, childId: child.id, commandId: command.id }, "side_pocket.failed");
    } finally {
      await adapter.close();
      this.active.delete(child.id);
      this.store.mail.cancelRequests(child.id);
    }
  }
  private launch(child: SidePocket, command: DelegationCommand) {
    const policy = this.store.parent(child.parentId).policy;
    const { sessionStarted } = object(JSON.parse(child.metadata));
    const adapter = createAdapter(child.harness, {
      config: this.config,
      child: { ...child, policy, ...(typeof sessionStarted === "boolean" && { sessionStarted }) },
      parentTools: parentToolServer(child.id, command.id),
      callbacks: {
        request: (request) => this.request(child, request),
        output: (text) =>
          this.store.mail.record(child.parentId, child.id, `output:${crypto.randomUUID()}`, "output", { text }, false),
        metadata: (data) => this.store.metadata(child.parentId, child.id, data),
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

      if (["queued", "sent", "unknown"].includes(receipt.status)) {
        this.store.mail.delivered(mail.id, receipt.status as "queued" | "sent" | "unknown");
      }
    }
  }
  private async dispatch() {
    for (const child of this.store.list(this.config.threadId)) {
      if (child.status === "closing") {
        await this.closeRequested(child);
      } else if (!this.active.has(child.id) && this.active.size < MAX_CONCURRENT_CHILDREN) {
        const command = this.store.claim(child.parentId, child.id);

        if (command) {
          this.launch(child, command);
        }
      }
    }
  }
  async tick() {
    if (this.ticking || this.stopped) {
      return;
    }

    this.ticking = true;

    try {
      this.answers();

      await this.dispatch();

      await this.forward();
    } catch (error) {
      log().error({ error }, "side_pocket.worker_failed");
    } finally {
      this.ticking = false;
    }
  }
  start() {
    this.store.recover(this.config.threadId);
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);

    for (const waiting of this.waiting.values()) {
      waiting.reject(new Error("Pocket is stopping; this request can be continued in the saved session."));
    }

    this.waiting.clear();
    const running = this.active.values().toArray();

    for (const entry of running) {
      await entry.adapter.close();
    }

    await Promise.allSettled(running.map((entry) => entry.done));
  }
}
