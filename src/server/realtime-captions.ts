import { createStore } from "zustand/vanilla";
import { t } from "try";
import { SerialQueue } from "../runtime/serial-queue";
import {
  captionFrame,
  openedCaptionBoundary,
  closedCaptionBoundary,
  liveCaptionState,
  receivedCaption,
  shouldAnchorCaption,
  type CaptionTransition,
} from "../state/realtime-captions";
import type { Data } from "../lib/protocol";
import type { VoiceSessionOwner } from "./voice-session-owner";
import { VoiceHistory } from "./voice-history";
import { log } from "./logging";

/**
Own caption publication and serialized durable writes independently of live media.
*/
export class RealtimeCaptions {
  private readonly store = createStore(liveCaptionState);
  private readonly queue = new SerialQueue();
  private history?: VoiceHistory;
  private persistence: Promise<void> = Promise.resolve();

  /** Bind the canonical conversation and UI event sink without starting storage work.
  @param owner - Selected conversation identity and canonical anchor reader.
  @param publish - Control event publisher; never an audio transport.
  */
  constructor(
    private owner: VoiceSessionOwner,
    private publish: (event: Data) => void
  ) {}

  /** Resolve the durable history owner for the selected conversation.
  @returns Its lazy persistence adapter.
  */
  private savedHistory() {
    this.history ??= new VoiceHistory(this.owner.threadId());

    return this.history;
  }

  /** Execute one immutable-fragment persistence command.
  @param final - Provider evidence and original chronological anchor.
  */
  private async write(final: NonNullable<CaptionTransition["final"]>) {
    await this.savedHistory().save(final);
  }

  /** Observe queued persistence without allowing its failure to stop media or later writes.
  @param operation - Owned caption write outcome.
  */
  private async observe(operation: Promise<void>) {
    const saved = await t(operation);

    if (saved.ok) {
      return;
    }

    log().error({ error: saved.error }, "realtime.history_save_failed");
    this.publish({ type: "warning", error: "Voice history could not be saved. Your live call is still connected." });
  }

  /** Publish an observed fragment immediately and queue its independent persistence.
  @param event - Original provider control frame.
  @param sessionId - Native call identity.
  */
  receive(event: Data, sessionId: string) {
    const state = this.store.getState();
    const canonical =
      state.boundary ?? (shouldAnchorCaption(state, event, sessionId) ? (this.owner.lastItemId?.() ?? null) : null);
    const received = receivedCaption(state, event, sessionId, canonical);

    this.store.setState(received.state, true);

    if (received.frame) {
      this.publish(received.frame);
    }

    if (received.final) {
      this.persistence = this.observe(this.queue.run(this.write.bind(this), received.final));
    }
  }

  /** Read already available context without waiting for queued caption writes.
  @returns Hydrated canonical voice history.
  */
  context() {
    return this.savedHistory().read();
  }

  /** Read immutable history after already queued writes have been observed.
  @returns Saved captions for context hydration or typed continuation.
  */
  async read() {
    await this.persistence;

    return this.context();
  }

  /** Read live caption state for a newly connected UI observer.
  @returns Bounded session-local caption frames.
  */
  live() {
    return Array.from(this.store.getState().captions.values(), captionFrame.bind(undefined));
  }

  /** Read observed fragments for backend context without waiting for persistence.
  @returns Detached immutable caption entries.
  */
  segments() {
    return this.store.getState().captions.values().toArray();
  }

  /** Capture observed speech and split subsequent groups before restart storage yields.
  @param id - New canonical notice identity.
  @returns Immutable fragments observed before that boundary.
  */
  boundary(id: string) {
    const previous = this.store.getState();

    this.store.setState(openedCaptionBoundary(previous, id), true);

    return previous.captions.values().toArray();
  }

  /** Release the temporary anchor once the canonical notice operation finishes.
  @param id - Completed canonical notice identity.
  */
  commitBoundary(id: string) {
    this.store.setState(closedCaptionBoundary(this.store.getState(), id), true);
  }

  /**
  Reset live projection while retaining the independent durable write queue.
  */
  reset() {
    this.store.setState(liveCaptionState(), true);
  }
}
