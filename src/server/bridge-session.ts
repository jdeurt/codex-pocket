import { type Config, readConfig } from "./config";
import { RpcDiagnosticEvent, RpcDisconnectEvent, RpcNotificationEvent } from "./rpc-events";
import { type RpcEvent, type Snapshot } from "../lib/protocol";
import { BridgeOutbox } from "./bridge-outbox";
import { BridgeSnapshots } from "./bridge-snapshots";
import { CodexRpc } from "./rpc";
import { applyBridgeEvent } from "./bridge-events";
import { loadHistory } from "./history";
import { log } from "./logging";
import { recordRestart } from "./restart-events";
import { resolveDesktopReplies } from "./desktop";
import { resumePocket } from "./pocket-runtime";
import { schedules } from "./schedules";
import { validateAnswer } from "./answers";
import { contextUsage } from "../lib/usage";
import { saveSessionSettings, type sessionSettingsSchema } from "./session-settings";
import { string } from "../lib/protocol";
import { type z } from "zod";
import { writeLocal } from "./local-state";

const DESKTOP_REPLY_INTERVAL_MS = 750;

/**
Coordinate native parent hydration, serialized operations and connection shutdown.
*/
export class Bridge {
  private rpc?: CodexRpc;

  private config?: Config;

  private connecting?: Promise<void>;

  private serial: Promise<unknown> = Promise.resolve();

  private messages: BridgeOutbox;

  private timer?: NodeJS.Timeout;

  private hydration?: RpcEvent[];

  private disposed = false;

  readonly snapshots = new BridgeSnapshots();

  /**
  Bind durable receipt delivery to this bridge's canonical snapshot owner.
  */
  constructor() {
    this.messages = new BridgeOutbox(this.snapshots);
  }

  /**
  Serialize parent operations while allowing work after an earlier failure.
  @param fn - Next parent operation in submission order.
  @returns This operation's result without swallowing its failure.
  */
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

  /**
  Publish connection failures after releasing hydration state and closing the child.
  */
  private async connect() {
    try {
      await this.openConnection();
    } catch (error) {
      this.hydration = undefined;
      this.rpc?.close();
      this.snapshot.connection = "disconnected";
      this.snapshots.fail(error, this.messages.entries);
      throw error;
    }
  }

  /**
  Resolve parent configuration before starting a native session.
  */
  private async openConnection() {
    const config = await readConfig();

    if (!config) {
      this.snapshot.connection = "unconfigured";
      this.snapshots.publish(this.messages.entries);

      return;
    }

    await this.initialize(config);
  }

  /**
  Publish connecting state and restore durable submissions before opening the transport.
  @param config - Validated parent launch and conversation configuration.
  */
  private async initialize(config: Config) {
    this.config = config;
    this.refreshScheduled();
    this.snapshot.connection = "connecting";
    this.snapshot.activity = undefined;
    this.snapshot.threadId = config.threadId;
    this.snapshot.error = undefined;
    this.snapshot.requests = [];
    this.snapshots.publish(this.messages.entries);
    await this.messages.restore(config.threadId);
    await this.hydrate(config);
  }

  /**
  Accept only this connection's native events and retain host-only diagnostics.
  @param rpc - Native client belonging to the current hydration attempt.
  */
  private observe(rpc: CodexRpc) {
    rpc.addEventListener("event", (event) => {
      if (!(event instanceof RpcNotificationEvent) || rpc !== this.rpc) {
        return;
      }

      if (this.hydration) {
        this.hydration.push(event.notification);
      } else {
        this.event(event.notification);
      }
    });
    rpc.addEventListener("disconnect", (event) => {
      if (!(event instanceof RpcDisconnectEvent) || rpc !== this.rpc) {
        return;
      }

      this.snapshot.connection = "disconnected";
      this.snapshot.error = event.error.message;
      this.snapshot.activeTurnId = undefined;
      this.snapshot.requests = [];
      void writeLocal("requests.json", []).catch(console.error);
      this.snapshots.publish(this.messages.entries);
    });
    // Diagnostics stay in the host terminal; they can contain local account details.
    rpc.addEventListener("diagnostic", (event) => {
      if (event instanceof RpcDiagnosticEvent) {
        log().debug({ text: event.text }, "codex.stderr");
      }
    });
  }

  /**
  Buffer native notifications until the saved parent history is restored.
  @param config - Validated parent configuration for the native handshake.
  */
  private async hydrate(config: Config) {
    const rpc = new CodexRpc();
    const events: RpcEvent[] = [];

    this.rpc = rpc;
    this.hydration = events;
    this.observe(rpc);
    await rpc.connect(config);
    await this.restoreHistory(rpc, config, events);
  }

  /**
  Restore canonical history before replaying buffered events and draining recovery work.
  @param rpc - Observed native client whose notifications are buffered.
  @param config - Validated parent configuration.
  @param events - This connection's ordered hydration buffer.
  */
  private async restoreHistory(rpc: CodexRpc, config: Config, events: RpcEvent[]) {
    const resumed = await resumePocket(rpc, config);
    const { thread } = resumed;

    this.snapshot.model = resumed.model;
    this.snapshot.reasoningEffort = resumed.reasoningEffort;
    this.snapshot.title = thread.name?.length ? thread.name : "Pocket";
    this.snapshot.turns = await loadHistory(rpc, thread);
    this.snapshot.activeTurnId = this.snapshot.turns.findLast((t) => t.status === "inProgress")?.id;
    this.hydration = undefined;

    for (const event of events) {
      this.event(event);
    }

    this.snapshot.restartEvents = await recordRestart(this.snapshot);

    await this.messages.recover(config.threadId);

    this.snapshot.connection = "connected";
    this.snapshots.publish(this.messages.entries);

    if (!this.timer) {
      this.timer = setInterval(
        () =>
          void resolveDesktopReplies(this.snapshot, this.rpc, () => {
            this.snapshots.publish(this.messages.entries);
          }).catch(console.error),
        DESKTOP_REPLY_INTERVAL_MS
      );
      this.timer.unref();
    }

    // Drain after hydration so a saved queued message cannot race turn restoration.
    void this.exclusive(() => this.messages.drain(this.rpc, this.config)).catch((error: unknown) => {
      this.snapshots.fail(error, this.messages.entries);
    });
  }

  /**
  Apply parent-scoped native changes before publishing the canonical snapshot.
  @param event - Validated native protocol event.
  */
  private event(event: RpcEvent) {
    if (event.params.threadId && event.params.threadId !== this.config?.threadId) {
      return;
    }

    applyBridgeEvent(this.snapshot, this.config, event);

    if (event.id === undefined && event.method === "turn/completed") {
      void this.exclusive(() => this.messages.drain(this.rpc, this.config)).catch((error: unknown) => {
        this.snapshots.fail(error, this.messages.entries);
      });
    }

    this.snapshots.publish(this.messages.entries);
  }

  /**
  Expose the canonical state owned by this bridge's snapshot publisher.
  @returns The current mutable canonical parent state.
  */
  get snapshot(): Snapshot {
    return this.snapshots.state;
  }

  /**
  Share one hydration attempt and reject new work after bridge shutdown.
  @returns Completion of the current hydration attempt.
  */
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

  /**
  Expose the existing connected transport for read-only agent inspection.
  @returns The current hydrated native client.
  */
  agentReader() {
    if (this.snapshot.connection !== "connected" || !this.rpc?.running) {
      throw new Error("Harness inspection is disconnected.");
    }

    return this.rpc;
  }

  /**
  Inspect the parent session using native event state and honest unknown usage values.
  @returns Effective settings, active identity, persistence timing and usage provenance.
  */
  sessionInfo() {
    return {
      threadId: this.snapshot.threadId,
      model: this.snapshot.model ?? null,
      effort: this.snapshot.reasoningEffort ?? null,
      activeTurnId: this.snapshot.activeTurnId ?? null,
      connection: this.snapshot.connection,
      usage: contextUsage(this.snapshot.usage),
      lastCompactionAt: this.snapshot.lastCompactionAt ?? null,
      effectiveFor: "subsequent turns; active work is unchanged",
      persistence: "Pocket saves accepted settings for this parent across reconnects and restarts",
    };
  }

  /**
  Serialize an explicit model/effort change on this parent's existing native connection.
  @param settings - Strict allowlisted model and effort fields, without permissions or arbitrary RPC.
  @returns Effective native readback after durable local persistence.
  */
  updateSession(settings: z.infer<typeof sessionSettingsSchema>) {
    return this.exclusive(async () => {
      await this.ensureConnected();

      const rpc = this.agentReader();
      const threadId = this.snapshot.threadId;

      if (!threadId) {
        throw new Error("Configure a parent chat first.");
      }

      await rpc.request("thread/settings/update", { threadId, ...settings });

      return this.readSessionSettings(rpc, threadId);
    });
  }

  /**
  Confirm effective settings through a native read before retaining them for reconnect.
  @param rpc - Existing connected native transport.
  @param threadId - Server-owned parent identity.
  @returns Current parent control state after readback and persistence.
  */
  private async readSessionSettings(rpc: CodexRpc, threadId: string) {
    const { thread } = await rpc.request("thread/read", { threadId, includeTurns: false });
    const model = string(thread.model);
    const effort = string(thread.reasoningEffort);

    if (!model) {
      throw new Error("Native settings were accepted but readback is unavailable. Inspect before retrying.");
    }

    await saveSessionSettings(threadId, { model, ...(effort && { effort }) });
    this.snapshot.model = model;
    this.snapshot.reasoningEffort = effort || null;
    this.snapshots.publish(this.messages.entries);

    return this.sessionInfo();
  }

  /**
  Refresh pending schedule delivery metadata for the configured parent.
  */
  refreshScheduled() {
    if (this.config) {
      this.snapshot.scheduled = Object.fromEntries(
        schedules()
          .occurrences.list(this.config.threadId)
          .filter((run) => run.status !== "cancelled")
          .map((run) => [run.id, { title: run.title, scheduledAt: run.scheduledAt }])
      );
    }
  }

  /**
  Serialize idempotent message acceptance with native connection and queue delivery.
  @param id - Caller-supplied durable message identity.
  @param text - User message text.
  @param attachmentIds - Managed upload identifiers in request order.
  @returns The message's durable delivery status.
  */
  async send(id: string, text: string, attachmentIds: string[] = []) {
    log().info({ id, text }, "message.received");

    return this.exclusive(async () => {
      await this.ensureConnected();

      if (!this.config || !this.rpc?.running) {
        throw new Error("Configure a thread on your computer first.");
      }

      return this.messages.send(this.config, this.rpc, id, text, attachmentIds);
    });
  }

  /**
  Serialize a validated answer against a still-pending native prompt.
  @param id - Native prompt identity.
  @param input - Untrusted answer from the HTTP boundary.
  @returns Completion after the resolved prompt has been persisted.
  */
  async answer(id: string | number, input: unknown) {
    return this.exclusive(async () => {
      const request = this.snapshot.requests.find((r) => r.id === id);

      if (!request || !this.rpc?.running) {
        throw new Error("This prompt is no longer waiting for an answer.");
      }

      this.rpc.respond(id, validateAnswer(request, input));
      this.snapshot.requests = this.snapshot.requests.filter((r) => r.id !== id);
      await writeLocal("requests.json", this.snapshot.requests);
      this.snapshots.publish(this.messages.entries);
    });
  }

  /**
  Stop desktop polling, snapshot publication and the native child.
  */
  close() {
    this.disposed = true;

    if (this.timer) {
      clearInterval(this.timer);
    }

    this.snapshots.close();

    this.rpc?.close();
  }
}
