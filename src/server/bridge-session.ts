import { BridgeCommands } from "./bridge-commands";
import { SerialQueue } from "../runtime/serial-queue";
import { t as captureResult } from "try";
import { type Config, readConfig } from "./config";
import { observeBridge } from "./bridge-observer";
import {
  type MessageSource,
  type RpcEvent,
  type Snapshot,
  messageSourceSchema,
  string,
  isTurnInProgress,
} from "../lib/protocol";
import { persistRequests, applyBridgeEvent, refreshSnapshotSchedules } from "./bridge-events";
import { BridgeOutbox } from "./bridge-outbox";
import { BridgeSnapshots } from "./bridge-snapshots";
import { CodexRpc } from "./rpc";
import { RealtimeSession } from "./realtime-session";
import { SessionControls } from "./session-controls";
import { loadHistory } from "./history";
import { log } from "./logging";
import { recordBridgeRestart } from "./restart-events";
import { pollDesktopReplies } from "./desktop";
import { resumePocket } from "./pocket-runtime";

const DESKTOP_REPLY_INTERVAL_MS = 750;

/**
Coordinate native parent hydration, serialized operations and connection shutdown.
*/
export class Bridge {
  private rpc?: CodexRpc;
  private config?: Config;
  private connecting?: Promise<void>;
  private messages: BridgeOutbox;
  private readonly commands: BridgeCommands;
  private timer?: NodeJS.Timeout;
  private hydration?: RpcEvent[];
  private disposed = false;
  /**
  Publish the currently owned snapshot and durable receipts.
  */
  private publish = () => {
    this.snapshots.publish(this.messages.entries);
  };

  /**
  Serialize desktop polling with accepted messages and answers.
  */
  private pollDesktop = () => {
    void this.exclusive(pollDesktopReplies, this.snapshots, this.rpc, this.publish);
  };

  readonly exclusive = new SerialQueue().run;
  readonly snapshots = new BridgeSnapshots();
  readonly realtime = new RealtimeSession(this);
  readonly session = new SessionControls(this, this.exclusive, this.publish);

  /** Serialize a validated answer against a still-pending native prompt.
  @param id - Native prompt identity.
  @param input - Untrusted answer from the HTTP boundary.
  @returns Completion after the resolved prompt has been persisted.
  */
  answer = (id: string | number, input: unknown) => this.exclusive(this.commands.answer, id, input);

  /** Bind durable receipt delivery to this bridge's canonical snapshot owner.
  @param configured - Optional named-Pocket configuration, independent of the original environment.
  */
  constructor(private configured?: Config) {
    this.messages = new BridgeOutbox(this.snapshots, configured?.pocketId);
    this.commands = new BridgeCommands(this, this.messages);
  }

  /**
  Publish connection failures after releasing hydration state and closing the child.
  */
  private async connect() {
    const completed = await captureResult(this.openConnection.bind(this));

    if (completed.ok) {
      return;
    }

    const error = completed.error;

    this.hydration = undefined;
    this.rpc?.close();
    this.snapshot = { ...this.snapshot, connection: "disconnected" };
    void this.realtime.disconnect("Pocket disconnected. Realtime stopped.");
    this.snapshots.fail(error, this.messages.entries);
    throw error;
  }

  /**
  Resolve parent configuration before starting a native session.
  */
  private async openConnection() {
    const config = this.configured ?? (await readConfig());

    if (!config) {
      this.snapshot = { ...this.snapshot, connection: "unconfigured" };
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
    this.snapshot = {
      ...this.snapshot,
      connection: "connecting",
      activity: undefined,
      threadId: config.threadId,
      error: undefined,
      requests: [],
    };
    this.snapshots.publish(this.messages.entries);
    await this.messages.restore(config.threadId);
    const rpc = new CodexRpc();
    const events: RpcEvent[] = [];

    this.rpc = rpc;
    this.hydration = events;
    observeBridge(rpc, this.notification.bind(this, rpc), this.disconnected.bind(this, rpc));
    await rpc.connect(config, "pi");
    await this.restoreHistory(rpc, config, events);
  }

  /** Accept notifications only from the current native connection.
  @param rpc - Connection that owns this listener.
  @param event - Native transport event.
  */
  private notification(rpc: CodexRpc, event: RpcEvent) {
    if (rpc !== this.rpc) {
      return;
    }

    if (this.hydration) {
      this.hydration.push(event);
    } else {
      this.event(event);
    }
  }

  /** Publish native connection loss without changing retained canonical history.
  @param rpc - Connection that owns this listener.
  @param error - Native disconnection failure.
  */
  private disconnected(rpc: CodexRpc, error: Error) {
    if (rpc !== this.rpc) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      connection: "disconnected",
      error: error.message,
      activeTurnId: undefined,
      requests: [],
    };
    void this.realtime.disconnect("Pocket disconnected. Realtime stopped.");
    void persistRequests(this.snapshot);
    this.publish();
  }

  /** Restore canonical history before replaying buffered events and draining recovery work.
  @param rpc - Observed native client whose notifications are buffered.
  @param config - Validated parent configuration.
  @param events - This connection's ordered hydration buffer.
  */
  private async restoreHistory(rpc: CodexRpc, config: Config, events: RpcEvent[]) {
    const resumed = await resumePocket(rpc, config);
    const { thread } = resumed;

    const turns = await loadHistory(rpc, thread);

    this.snapshot = {
      ...this.snapshot,
      model: resumed.model,
      executionBoundary: string(thread.executionBoundary) || undefined,
      reasoningEffort: resumed.reasoningEffort,
      title: thread.name?.length ? thread.name : "Pocket",
      turns,
      activityState: undefined,
      activeTurnId: turns.findLast(isTurnInProgress)?.id,
    };
    this.hydration = undefined;

    for (const event of events) {
      this.event(event);
    }

    await recordBridgeRestart(this);
    await this.messages.recover(config.threadId);

    this.snapshot = { ...this.snapshot, connection: "connected", connectionRetry: undefined };
    this.snapshots.publish(this.messages.entries);

    if (!this.timer) {
      this.timer = setInterval(this.pollDesktop, DESKTOP_REPLY_INTERVAL_MS);
      this.timer.unref();
    }

    // Drain after hydration so a saved queued message cannot race turn restoration.
    void this.drainMessages();
  }

  /** Apply parent-scoped native changes before publishing the canonical snapshot.
  @param event - Validated native protocol event.
  */
  private event(event: RpcEvent) {
    if (event.params.threadId && event.params.threadId !== this.config?.threadId) {
      return;
    }

    this.snapshot = applyBridgeEvent(this.snapshot, this.config, event);

    if (event.id === undefined && event.method === "turn/completed") {
      this.realtime.completed(event.params.turn);
      void this.drainMessages();
    }

    this.snapshots.publish(this.messages.entries);
  }

  /**
  Drain queued messages and publish an actionable failure when dispatch fails.
  */
  private async drainMessages() {
    const drained = await captureResult(this.exclusive(this.messages.drain.bind(this.messages), this.rpc, this.config));

    if (!drained.ok) {
      this.snapshots.fail(drained.error, this.messages.entries);
    }
  }

  /** Expose canonical parent state.
  @returns The current canonical snapshot.
  */
  get snapshot(): Snapshot {
    return this.snapshots.state;
  }

  /** Replace canonical data at the explicit observable runtime boundary.
  @param state - Next canonical snapshot.
  */
  set snapshot(state: Snapshot) {
    this.snapshots.state = state;
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

    const completed = await captureResult(this.connecting);

    this.connecting = undefined;

    if (!completed.ok) {
      throw completed.error;
    }
  }

  /** Read the current validated connection for an accepted operation.
  @returns Native transport and its parent configuration.
  */
  connection() {
    if (!this.config || !this.rpc?.running) {
      throw new Error("Configure a thread on your computer first.");
    }

    return { rpc: this.rpc, config: this.config };
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
    this.snapshot = refreshSnapshotSchedules(this.snapshot, this.config);
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

    return this.exclusive(this.commands.send, id, text, attachmentIds, source);
  }

  /** Accept the realtime agent's worker request through the durable submission path.
  @param input - Agent-authored request and provider tool-call provenance.
  @returns Durable delivery receipt, including an existing receipt on an identical retry.
  */
  handoff(input: { id: string; request: string; source: MessageSource }) {
    return this.send(input.id, input.request, [], messageSourceSchema.parse(input.source));
  }

  /**
  Stop polling, publication and the native child.
  */
  close() {
    this.disposed = true;
    void this.realtime.disconnect("Pocket stopped. Realtime stopped.");

    clearInterval(this.timer);

    this.snapshots.close();
    this.rpc?.close();
  }
}
