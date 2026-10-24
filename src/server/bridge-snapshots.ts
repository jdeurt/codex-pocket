import { type Snapshot, initialSnapshot } from "../lib/protocol";
import type { Receipt } from "./outbox";
import { log } from "./logging";
import { receiptProjection } from "../state/receipt-projection";
import { observable } from "../runtime/stores";

const SNAPSHOT_THROTTLE_MS = 40;

/**
Own canonical snapshot state and its coalesced publication lifetime.
*/
export class BridgeSnapshots extends EventTarget {
  private timer?: NodeJS.Timeout;

  /**
  Publish a coalesced snapshot notification through the native event boundary.
  */
  private notify = () => {
    this.timer = undefined;
    log().debug(
      {
        connection: this.state.connection,
        activeTurnId: this.state.activeTurnId,
        turns: this.state.turns.length,
        queued: this.state.queue.length,
        requests: this.state.requests.length,
      },
      "bridge.snapshot"
    );
    this.dispatchEvent(new Event("snapshot"));
  };

  readonly store = observable<Snapshot>(structuredClone(initialSnapshot));

  /** Read the current canonical snapshot from its observable runtime owner.
  @returns Latest published state.
  */
  get state() {
    return this.store.getState();
  }

  /** Replace canonical data through the observable runtime boundary.
  @param state - Next immutable canonical snapshot.
  */
  set state(state: Snapshot) {
    this.store.setState(state, true);
  }

  /**
  Restore receipt metadata before coalescing updates into one snapshot notification.
  @param receipts - Current durable submissions used to project attachments.
  */
  publish(receipts: Receipt[]) {
    this.state = receiptProjection(this.state, receipts);

    if (this.timer) {
      return;
    }

    this.timer = setTimeout(this.notify, SNAPSHOT_THROTTLE_MS);
  }

  /**
  Publish an operation failure without replacing the canonical transcript.
  @param error - Failed native or persistence operation.
  @param receipts - Current durable submissions for attachment projection.
  */
  fail(error: unknown, receipts: Receipt[]) {
    log().error({ error }, "bridge.failed");
    this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
    this.publish(receipts);
  }

  /**
  Cancel publication when the owning native bridge stops.
  */
  close() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }
}
