import { Bridge, bridge } from "./bridge";
import { type Config } from "./config";
import { DelegationWorker } from "./delegation-worker";
import { Scheduler } from "./scheduler";
import { type Snapshot } from "../lib/protocol";
import { delegations } from "./delegations";
import { parentReaders } from "./pocket-readers";
import { pocketStore } from "./pocket-store";
import { schedules } from "./schedules";
import { visiblePreview } from "./agent-history";
import { visibleSnapshot } from "./visible-snapshot";

const PREVIEW_LIMIT = 180;

/** Map live parent state without treating disconnection as completion.
@param state - Canonical parent snapshot.
@returns Compact user-facing menu status.
*/
function pocketStatus(state: Snapshot) {
  if (state.connection !== "connected") {
    return "Reconnecting…";
  }

  if (state.requests.length > 0) {
    return "Needs input";
  }

  return state.activeTurnId ? "Working" : "Ready";
}

/** Refuse deletion while accepted parent, child, or scheduled work remains.
@param state - Connected parent's canonical snapshot.
*/
function requireIdle(state: Snapshot) {
  const owner = state.threadId ?? "";
  const store = delegations();
  const children = store.list(owner);
  const isPending = schedules()
    .occurrences.list(owner)
    .some((run) => ["pending", "queued", "sending", "unknown"].includes(run.status));
  const hasChildren = children.some(
    (child) =>
      !["idle", "closed"].includes(child.status) ||
      store.queue
        .list(owner, child.id)
        .some((command) => ["queued", "running", "pending", "sending", "unknown"].includes(command.status))
  );
  const hasReports = store.mail.pending(owner).length > 0;

  if (
    isPending ||
    hasChildren ||
    hasReports ||
    state.activeTurnId ||
    state.requests.length > 0 ||
    state.queue.length > 0
  ) {
    throw new Error("This Pocket still has work or an unresolved delivery. Finish it before deleting.");
  }

  if (
    schedules()
      .list(owner)
      .some((schedule) => schedule.active)
  ) {
    throw new Error("This Pocket has active schedules. Disable them before deleting.");
  }
}

/**
Keep one parent and its background work alive independently of open browser tabs.
*/
export class NamedRuntime {
  private scheduler: Scheduler;
  private worker: DelegationWorker;
  private connecting?: Promise<void>;
  private started = false;

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
    this.bridge.snapshots.addEventListener("snapshot", () => {
      this.preview();
    });
    parentReaders.set(config.threadId, this.bridge);
  }

  /**
  Save only content already allowed in the phone transcript.
  */
  private preview() {
    const state = this.bridge.snapshot;
    const preview =
      state.activeTurnId && state.activity
        ? state.activity
        : visiblePreview(
            visibleSnapshot(state)
              .turns.flatMap((turn) => turn.items)
              .toReversed()
          );

    pocketStore().preview(this.id, preview.slice(0, PREVIEW_LIMIT), pocketStatus(state));
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

    await (async () => this.connecting)().finally(() => {
      this.connecting = undefined;
    });
  }

  /**
  Serialize deletion against message acceptance before stopping an idle runtime.
  */
  async remove() {
    await this.bridge.exclusive(async () => {
      await this.bridge.ensureConnected();
      requireIdle(this.bridge.snapshot);
      pocketStore().remove(this.id);
      this.bridge.snapshot.connection = "disconnected";
      this.bridge.snapshot.error = "This Pocket was deleted. Choose another Pocket from the menu.";
      this.bridge.snapshots.dispatchEvent(new Event("snapshot"));
      this.bridge.close();
    });
    await this.close();
  }

  /**
  Release timers and native resources when the host stops.
  */
  async close() {
    this.scheduler.stop();
    await this.worker.stop();
    this.bridge.close();
    parentReaders.delete(this.config.threadId);
  }
}
