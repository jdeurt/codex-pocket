import type { RpcEvent, Turn } from "../lib/protocol";
import { type PiState, type PiHistoryState, piTurnState } from "../state/pi-session";
import { findById } from "../lib/identity";
import { observable } from "./stores";
import { SerialQueue } from "./serial-queue";
import { savePiState } from "../server/pi-store";

/**
Own canonical Pi publication and ordered persistence independently of native model execution.
*/
export class PiHistory {
  private readonly store = observable<PiHistoryState>({});
  private readonly persistence = new SerialQueue();
  private writes: Promise<void> = Promise.resolve();

  /** Read the active identity for native question callbacks.
  @returns Current canonical turn identity.
  */
  activeIdentity = () => this.store.getState().activeId;

  /** Bind persistence and event publication to one verified parent.
  @param owner - Parent identity.
  @param emit - Canonical event sink.
  */
  constructor(
    private readonly owner: string,
    private readonly emit: (event: RpcEvent) => void
  ) {}

  /** Replace state after durable startup hydration.
  @param saved - Validated persisted native projection.
  */
  restore(saved: PiState) {
    this.store.setState({ saved }, true);
  }

  /** Read the latest immutable durable projection.
  @returns Current projection when hydrated.
  */
  get saved() {
    return this.store.getState().saved;
  }

  /** Read the current turn from canonical history.
  @returns Current turn when work is active.
  */
  get active() {
    return findById(this.saved?.turns ?? [], this.activeIdentity());
  }

  /** Replace a turn while retaining or explicitly changing its active identity.
  @param turn - New immutable turn.
  @param activeId - Explicit active identity, absent for terminal work.
  */
  update(turn: Turn, activeId: string | undefined) {
    this.store.setState(piTurnState(this.store.getState(), turn, activeId), true);
  }

  /** Publish a pure message projection after replacing canonical state.
  @param update - Immutable turn and its ordered canonical events.
  */
  publish(update: { turn: Turn; events: RpcEvent[] }) {
    this.update(update.turn, this.activeIdentity());

    for (const event of update.events) {
      this.emit(event);
    }
  }

  /** Serialize an immutable snapshot; previous failures remain with their callers.
  @returns Completion after this captured projection is durable.
  */
  persist() {
    const state = this.saved;

    if (state) {
      this.writes = this.persistence.run(savePiState, this.owner, structuredClone(state));
    }

    return this.writes;
  }

  /** Join the latest queued persistence operation during shutdown.
  @returns Durable write completion or its failure.
  */
  flush() {
    return this.writes;
  }
}
