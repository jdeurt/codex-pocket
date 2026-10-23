import { type Config, readConfig } from "./config";
import { RpcDiagnosticEvent, RpcDisconnectEvent, RpcNotificationEvent } from "./rpc-events";
import { type MessageSource, type RpcEvent, type Snapshot, messageSourceSchema, string } from "../lib/protocol";
import { applyBridgeEvent, refreshSnapshotSchedules } from "./bridge-events";
import { BridgeOutbox } from "./bridge-outbox";
import { BridgeSnapshots } from "./bridge-snapshots";
import { CodexRpc } from "./rpc";
import { RealtimeSession } from "./realtime-session";
import { SessionControls } from "./session-controls";
import { loadHistory } from "./history";
import { log } from "./logging";
import { recordRestart } from "./restart-events";
import { requestFile } from "./request-files";
import { resolveDesktopReplies } from "./desktop";
import { resumePocket } from "./pocket-runtime";
import { validateAnswer } from "./answers";
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
  readonly realtime = new RealtimeSession(this);
  readonly session = new SessionControls(
    this,
    (operation) => this.exclusive(operation),
    () => {
      this.snapshots.publish(this.messages.entries);
    }
  );

  /** Bind durable receipt delivery to this bridge's canonical snapshot owner.
  @param configured - Optional named-Pocket configuration, independent of the original environment.
  */
  constructor(private configured?: Config) {
    this.messages = new BridgeOutbox(this.snapshots, configured?.pocketId);
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
      this.realtime.disconnect("Pocket disconnected. Realtime stopped.");
      this.snapshots.fail(error, this.messages.entries);
      throw error;
    }
  }

  /**
  Resolve parent configuration before starting a native session.
  */
  private async openConnection() {
    const config = this.configured ?? (await readConfig());

    if (!config) {
      this.snapshot.connection = "unconfigured";
      this.snapshots.publish(this.messages.entries);

      return;
    }

    await this.initialize(config);
  }

  /** Publish connecting state and restore durable submissions before opening the transport.
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

  /** Accept only this connection's native events and retain host-only diagnostics.
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
      this.realtime.disconnect("Pocket disconnected. Realtime stopped.");
      this.snapshot.error = event.error.message;
      this.snapshot.activeTurnId = undefined;
      this.snapshot.requests = [];
      void writeLocal(requestFile(this.snapshot.threadId), []).catch(console.error);
      this.snapshots.publish(this.messages.entries);
    });
    // Diagnostics stay in the host terminal; they can contain local account details.
    rpc.addEventListener("diagnostic", (event) => {
      if (event instanceof RpcDiagnosticEvent) {
        log().debug({ text: event.text }, "codex.stderr");
      }
    });
  }

  /** Buffer native notifications until the saved parent history is restored.
  @param config - Validated parent configuration for the native handshake.
  */
  private async hydrate(config: Config) {
    const rpc = new CodexRpc();
    const events: RpcEvent[] = [];

    this.rpc = rpc;
    this.hydration = events;
    this.observe(rpc);
    await rpc.connect(config, "pi");
    await this.restoreHistory(rpc, config, events);
  }

  /** Restore canonical history before replaying buffered events and draining recovery work.
  @param rpc - Observed native client whose notifications are buffered.
  @param config - Validated parent configuration.
  @param events - This connection's ordered hydration buffer.
  */
  private async restoreHistory(rpc: CodexRpc, config: Config, events: RpcEvent[]) {
    const resumed = await resumePocket(rpc, config);
    const { thread } = resumed;

    this.snapshot.model = resumed.model;
    this.snapshot.executionBoundary = string(thread.executionBoundary) || undefined;
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

    Object.assign(this.snapshot, { connection: "connected", connectionRetry: undefined });
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

  /** Apply parent-scoped native changes before publishing the canonical snapshot.
  @param event - Validated native protocol event.
  */
  private event(event: RpcEvent) {
    if (event.params.threadId && event.params.threadId !== this.config?.threadId) {
      return;
    }

    applyBridgeEvent(this.snapshot, this.config, event);

    if (event.id === undefined && event.method === "turn/completed") {
      this.realtime.completed(event.params.turn);
      void this.exclusive(() => this.messages.drain(this.rpc, this.config)).catch((error: unknown) => {
        this.snapshots.fail(error, this.messages.entries);
      });
    }

    this.snapshots.publish(this.messages.entries);
  }

  /** Serialize parent operations while allowing work after an earlier failure.
  @param fn - Next parent operation in submission order.
  @returns This operation's result without swallowing its failure.
  */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
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

  /** Expose canonical parent state.
  @returns The current mutable snapshot.
  */
  get snapshot(): Snapshot {
    return this.snapshots.state;
  }

  /** Share one hydration attempt and reject new work after bridge shutdown.
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

  /** Expose the connected transport for read-only inspection.
  @returns The current hydrated client.
  */
  agentReader() {
    if (this.snapshot.connection !== "connected" || !this.rpc?.running) {
      throw new Error("Harness inspection is disconnected.");
    }

    return this.rpc;
  }

  /**
  Refresh pending schedules for this parent.
  */
  refreshScheduled() {
    refreshSnapshotSchedules(this.snapshot, this.config);
  }

  /** Serialize idempotent message acceptance with native connection and queue delivery.
  @param id - Caller-supplied durable message identity.
  @param text - User message text.
  @param attachmentIds - Managed upload identifiers in request order.
  @param source - Optional finalized voice source retained with the durable receipt.
  @returns The message's durable delivery status.
  */
  async send(id: string, text: string, attachmentIds: string[] = [], source?: MessageSource) {
    log().info({ id, text }, "message.received");

    return this.exclusive(async () => {
      await this.ensureConnected();

      if (!this.config || !this.rpc?.running) {
        throw new Error("Configure a thread on your computer first.");
      }

      if (!source && this.realtime.status().type !== "idle") {
        throw new Error("Stop realtime before sending a typed message.");
      }

      return this.messages.send(this.config, this.rpc, id, text, attachmentIds, source);
    });
  }

  /** Accept finalized user speech through the existing durable submission path.
  @param input - Stable finalized transcript and provider provenance.
  @returns Durable delivery receipt, including an existing receipt on an identical retry.
  */
  handoff(input: { id: string; transcript: string; source: MessageSource }) {
    return this.send(input.id, input.transcript, [], messageSourceSchema.parse(input.source));
  }

  /** Serialize a validated answer against a still-pending native prompt.
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
      await writeLocal(requestFile(this.snapshot.threadId), this.snapshot.requests);
      this.snapshots.publish(this.messages.entries);
    });
  }

  /**
  Stop polling, publication and the native child.
  */
  close() {
    this.disposed = true;
    this.realtime.disconnect("Pocket stopped. Realtime stopped.");

    if (this.timer) {
      clearInterval(this.timer);
    }

    this.snapshots.close();
    this.rpc?.close();
  }
}
