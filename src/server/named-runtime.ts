import { t as captureResult } from "try";
import { Bridge, bridge } from "./bridge";
import { type Config } from "./config";
import { DelegationWorker } from "./delegation-worker";
import { Scheduler } from "./scheduler";
import { pocketPreview, requireIdle } from "../state/pocket-lifecycle";
import { delegations } from "./delegations";
import { parentReaders } from "./pocket-readers";
import { pocketStore } from "./pocket-store";
import { schedules } from "./schedules";

/**
Keep one parent and its background work alive independently of open browser tabs.
*/
export class NamedRuntime {
  private scheduler: Scheduler;
  private worker: DelegationWorker;
  private connecting?: Promise<void>;
  private started = false;

  /**
  Publish the current immutable preview after a canonical snapshot changes.
  */
  private preview = () => {
    const value = pocketPreview(this.bridge.snapshot);

    pocketStore().preview(this.id, value.text, value.status);
  };

  readonly bridge: Bridge;

  /** Bind one saved identity to independent native and scheduled resource owners.
  @param id - Saved menu identity.
  @param config - Verified native parent and host policy.
  */
  constructor(
    private id: string,
    private config: Config
  ) {
    this.bridge = id === "main" ? bridge : new Bridge(config);
    this.scheduler = new Scheduler(schedules(), this.bridge, config.threadId);
    this.worker = new DelegationWorker(delegations(), this.bridge, config);
    this.bridge.snapshots.addEventListener("snapshot", this.preview);
    parentReaders.set(config.threadId, this.bridge);
  }

  /**
  Read durable work before committing a serialized deletion.
  */
  private async removeIdle() {
    await this.bridge.ensureConnected();
    const state = this.bridge.snapshot;
    const owner = state.threadId ?? "";
    const store = delegations();
    const children = store.list(owner);
    const commands = [];

    for (const child of children) {
      commands.push(...store.queue.list(owner, child.id));
    }

    requireIdle(state, {
      children,
      commands,
      runs: schedules().occurrences.list(owner),
      schedules: schedules().list(owner),
      reports: store.mail.pending(owner).length,
    });
    pocketStore().remove(this.id);
    this.bridge.snapshots.removeEventListener("snapshot", this.preview);
    this.bridge.snapshot = {
      ...state,
      connection: "disconnected",
      error: "This Pocket was deleted. Choose another Pocket from the menu.",
    };
    this.bridge.snapshots.dispatchEvent(new Event("snapshot"));
    this.bridge.close();
  }

  /**
  Retry native hydration without starting background workers more than once.
  */
  private async open() {
    await this.bridge.ensureConnected();

    if (!this.started) {
      this.started = true;
      this.scheduler.start();
      this.worker.start();
    }

    this.preview();
  }

  /**
  Coalesce concurrent startup requests and allow an explicit later reconnect.
  */
  async connect() {
    this.connecting ??= this.open();

    const completed = await captureResult(this.connecting);

    this.connecting = undefined;

    if (!completed.ok) {
      throw completed.error;
    }
  }

  /**
  Serialize deletion against message acceptance before stopping an idle runtime.
  */
  async remove() {
    await this.bridge.exclusive(this.removeIdle.bind(this));
    await this.close();
  }

  /**
  Release timers and native resources when the host stops.
  */
  async close() {
    this.scheduler.stop();
    const stopped = await captureResult(this.worker.stop.bind(this.worker));

    this.bridge.snapshots.removeEventListener("snapshot", this.preview);
    this.bridge.close();
    parentReaders.delete(this.config.threadId);

    if (!stopped.ok) {
      throw stopped.error;
    }
  }
}
