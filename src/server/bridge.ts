import { CodexRpc, requireConnectedRpc } from "./rpc";
import { type Config, readConfig } from "./config";
import { type Receipt, persistReceipts, restoreReceipts } from "./outbox";
import { type RpcEvent, type Snapshot, initialSnapshot } from "../lib/protocol";
import { assertMessageContent, projectAttachments, resolveUploads } from "./uploads";
import { EventEmitter } from "node:events";
import { drainReceipts } from "./bridge-delivery";
import { loadHistory } from "./history";
import { log } from "./logging";
import { notifyTurnComplete } from "./push";
import { queueRecovery } from "./recovery";
import { recordRestart } from "./restart-events";
import { reduceEvent } from "./reducer";
import { resolveDesktopReplies } from "./desktop";
import { resumePocket } from "./pocket-runtime";
import { schedules } from "./schedules";
import { validateAnswer } from "./answers";
import { writeLocal } from "./local-state";

const SNAPSHOT_THROTTLE_MS = 40;
const DESKTOP_REPLY_INTERVAL_MS = 750;

export class Bridge extends EventEmitter {
  private rpc?: CodexRpc;
  private config?: Config;
  private connecting?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private receipts: Receipt[] = [];
  private timer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private hydration?: RpcEvent[];
  private disposed = false;
  snapshot: Snapshot = structuredClone(initialSnapshot);
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    const result = (async () => {
      try {
        await previous;
      } catch {
        // A failed operation must not block the next one.
      }

      return fn();
    })();
    this.serial = result;

    return result;
  }
  private publish() {
    projectAttachments(this.snapshot, this.receipts);

    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      log().debug(
        {
          connection: this.snapshot.connection,
          activeTurnId: this.snapshot.activeTurnId,
          turns: this.snapshot.turns.length,
          queued: this.snapshot.queue.length,
          requests: this.snapshot.requests.length,
        },
        "bridge.snapshot"
      );
      this.emit("snapshot", this.snapshot);
    }, SNAPSHOT_THROTTLE_MS);
  }
  private async persist() {
    if (!this.config) {
      return;
    }

    this.receipts = await persistReceipts(this.config.threadId, this.receipts);
    this.snapshot.queue = this.receipts.filter((r) => r.status !== "sent");
    this.publish();
  }
  private async connect() {
    try {
      await this.openConnection();
    } catch (error) {
      this.hydration = undefined;
      this.rpc?.close();
      this.snapshot.connection = "disconnected";
      this.fail(error);
      throw error;
    }
  }
  private async openConnection() {
    const config = await readConfig();

    if (!config) {
      this.snapshot.connection = "unconfigured";
      this.publish();

      return;
    }

    this.config = config;
    this.refreshScheduled();
    this.snapshot.connection = "connecting";
    this.snapshot.activity = undefined;
    this.snapshot.threadId = config.threadId;
    this.snapshot.error = undefined;
    this.snapshot.requests = [];
    this.publish();
    this.receipts = await restoreReceipts(config.threadId);
    await this.persist();
    const rpc = new CodexRpc();
    this.rpc = rpc;
    this.hydration = [];
    rpc.on("event", (event: RpcEvent) => {
      if (rpc !== this.rpc) {
        return;
      }

      if (this.hydration) {
        this.hydration.push(event);
      } else {
        this.event(event);
      }
    });
    rpc.on("disconnect", (error: Error) => {
      if (rpc !== this.rpc) {
        return;
      }

      this.snapshot.connection = "disconnected";
      this.snapshot.error = error.message;
      this.snapshot.activeTurnId = undefined;
      this.snapshot.requests = [];
      void writeLocal("requests.json", []).catch(console.error);
      this.publish();
    });
    // Diagnostics stay in the host terminal; they can contain local account details.
    rpc.on("diagnostic", (text: string) => {
      log().debug({ text }, "codex.stderr");
    });
    await rpc.connect(config);
    const resumed = await resumePocket(rpc, config);
    const { thread } = resumed;
    this.snapshot.model = resumed.model;
    this.snapshot.reasoningEffort = resumed.reasoningEffort;
    this.snapshot.title = thread.name?.length ? thread.name : "Pocket";
    this.snapshot.turns = await loadHistory(rpc, thread);
    this.snapshot.activeTurnId = this.snapshot.turns.findLast((t) => t.status === "inProgress")?.id;
    const events = this.hydration;
    this.hydration = undefined;

    for (const event of events) {
      this.event(event);
    }

    this.snapshot.restartEvents = await recordRestart(this.snapshot);

    if (queueRecovery(this.snapshot, this.receipts)) {
      await this.persist();
    }

    this.snapshot.connection = "connected";
    this.publish();

    if (!this.timer) {
      this.timer = setInterval(
        () =>
          void resolveDesktopReplies(this.snapshot, this.rpc, () => {
            this.publish();
          }).catch(console.error),
        DESKTOP_REPLY_INTERVAL_MS
      );
      this.timer.unref();
    }

    // Drain after hydration so a saved queued message cannot race turn restoration.
    void this.exclusive(() => this.drain()).catch((error: unknown) => {
      this.fail(error);
    });
  }
  private event(event: RpcEvent) {
    if (event.params.threadId && event.params.threadId !== this.config?.threadId) {
      return;
    }

    if (event.id === undefined) {
      reduceEvent(this.snapshot, event);

      if (event.method === "serverRequest/resolved" || event.method === "turn/completed") {
        if (event.method === "turn/completed") {
          this.snapshot.requests = this.snapshot.requests.filter((r) => r.params.turnId !== event.params.turn?.id);
        }

        void writeLocal("requests.json", this.snapshot.requests).catch(console.error);
      }

      if (event.method === "turn/completed") {
        if (this.config && event.params.turn) {
          const completed = event.params.turn;
          const turn = this.snapshot.turns.find((entry) => entry.id === completed.id) ?? completed;
          void notifyTurnComplete(this.config.threadId, turn).catch(console.error);
        }

        void this.exclusive(() => this.drain()).catch((error: unknown) => {
          this.fail(error);
        });
      }
    } else {
      this.snapshot.requests.push({ ...event, id: event.id });
      void writeLocal("requests.json", this.snapshot.requests).catch(console.error);
      console.info(`\nCodex needs input on this computer: ${event.method}\nRun: npm run desktop -- requests\n`);
    }

    this.publish();
  }

  private async drain() {
    if (!this.rpc?.running || this.snapshot.connection !== "connected") {
      return;
    }

    await drainReceipts(
      this.rpc,
      this.config,
      this.snapshot,
      this.receipts,
      () => this.persist(),
      (error) => {
        this.fail(error);
      }
    );
  }

  private fail(error: unknown) {
    log().error({ error }, "bridge.failed");
    this.snapshot.error = error instanceof Error ? error.message : String(error);
    this.publish();
  }
  async ensureConnected() {
    if (this.disposed) {
      throw new Error("Bridge has stopped.");
    }

    if (this.connecting) {
      return this.connecting;
    }

    if (this.rpc?.running && this.snapshot.connection === "connected") {
      return;
    }

    this.connecting = this.connect();

    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  agentReader() {
    return requireConnectedRpc(this.rpc, this.snapshot.connection === "connected");
  }
  refreshScheduled() {
    if (this.config) {
      this.snapshot.scheduled = Object.fromEntries(
        schedules()
          .runs(this.config.threadId)
          .filter((run) => run.status !== "cancelled")
          .map((run) => [run.id, { title: run.title, scheduledAt: run.scheduledAt }])
      );
    }
  }
  async send(id: string, text: string, attachmentIds: string[] = []) {
    log().info({ id, text }, "message.received");

    return this.exclusive(async () => {
      await this.ensureConnected();

      if (!this.config || !this.rpc?.running) {
        throw new Error("Configure a thread on your computer first.");
      }

      const existing = this.receipts.find((r) => r.id === id);

      if (existing) {
        assertMessageContent(existing, text, attachmentIds);

        return { id, status: existing.status };
      }

      const attachments = await resolveUploads(this.config.threadId, attachmentIds);
      const receipt: Receipt = { id, text, ...(attachments.length > 0 && { attachments }), status: "queued" };
      this.receipts.push(receipt);
      await this.persist();
      await this.drain();
      log().info({ id, status: receipt.status }, "message.delivery");

      return { id, status: receipt.status };
    });
  }
  async answer(id: string | number, input: unknown) {
    return this.exclusive(async () => {
      const request = this.snapshot.requests.find((r) => r.id === id);

      if (!request || !this.rpc?.running) {
        throw new Error("This prompt is no longer waiting for an answer.");
      }

      this.rpc.respond(id, validateAnswer(request, input));
      this.snapshot.requests = this.snapshot.requests.filter((r) => r.id !== id);
      await writeLocal("requests.json", this.snapshot.requests);
      this.publish();
    });
  }
  close() {
    this.disposed = true;

    if (this.timer) {
      clearInterval(this.timer);
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.rpc?.close();
  }
}

declare global {
  var codexPocketBridge: Bridge | undefined;
}

const instance = globalThis.codexPocketBridge ?? new Bridge();

if (!globalThis.codexPocketBridge) {
  Object.defineProperty(globalThis, "codexPocketBridge", { value: instance, configurable: true });
}

export const bridge = instance;
