import { t } from "try";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiMessages } from "../server/pi-projection";
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
  @param onError - Private diagnostic sink for background projection failures.
  */
  constructor(
    private readonly owner: string,
    private readonly emit: (event: RpcEvent) => void,
    private readonly onError: (error: unknown) => void
  ) {}

  /** Normalize streamed messages and final source entries into existing Bridge notifications.
  @param messages - Native receipt identity owner.
  @param event - Authoritative Pi lifecycle or message event.
  @returns Whether the updated projection must be persisted.
  */
  private projectEvent(messages: PiMessages, event: AgentSessionEvent) {
    if (event.type === "compaction_end" && event.result) {
      this.emit({ method: "thread/compacted", params: { threadId: this.owner } });
    }

    if (event.type === "agent_settled" && event.aborted && this.active) {
      this.update({ ...this.active, status: "interrupted" }, this.active.id);
    }

    if (
      !this.active ||
      (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end")
    ) {
      return;
    }

    this.publish(messages.project(event.message, this.active, this.saved?.turns ?? [], this.owner));

    return event.type === "message_end";
  }

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

  /** Report background projection or persistence failures without rejecting an unobserved event callback.
  @param messages - Native receipt identity owner.
  @param event - Native lifecycle event.
  */
  async event(messages: PiMessages, event: AgentSessionEvent) {
    const projected = t(this.projectEvent.bind(this), messages, event);
    const saved = projected.ok && projected.value ? await t(this.persist.bind(this)) : projected;

    if (!saved.ok) {
      this.onError(saved.error);
    }
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
