import { t as captureResult } from "try";
import { dataSchema } from "../lib/protocol";
import { voiceHistorySchema } from "../lib/voice-history";
import { mergeCaptions, type VoiceStore } from "../runtime/stores";

const HISTORY_TIMEOUT_MS = 10_000;

/**
Runtime owner of the caption connection, independent of the audio connection.
*/
export class CaptionHistory {
  private generation = 0;
  private isActive = false;
  private pending: AbortController | undefined;

  /** Capture a background history failure only while its request is still owned.
  @returns Completion after accepted history or its error is published.
  */
  private reload = async () => {
    const task = this.refresh();
    const attempt = this.generation;
    const result = await captureResult(task);

    if (!result.ok && this.isCurrent(attempt) && !this.pending?.signal.aborted) {
      this.store.setState({ historyError: "Voice history could not load. Reconnect Pocket and try again." });
    }
  };

  /**
  Schedule an independent caption refresh from a browser notification.
  */
  private onHistory = () => {
    void this.reload();
  };

  /**
  Invalidate in-flight history and release the native listener.
  */
  private disconnect = () => {
    this.isActive = false;
    this.generation++;
    this.pending?.abort();
    globalThis.removeEventListener("pocket-voice-history", this.onHistory);
  };

  /** Read durable captions without pausing or owning live media.
  @returns Completion after fresh history is published.
  */
  refresh = async () => {
    if (!this.isActive) {
      return;
    }

    const attempt = ++this.generation;
    const controller = new AbortController();

    this.pending?.abort();
    this.pending = controller;
    const response = await fetch(this.url, {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(HISTORY_TIMEOUT_MS)]),
    });

    if (!response.ok) {
      throw new Error("Voice history could not load. Reconnect Pocket and try again.");
    }

    const result = dataSchema.parse(await response.json());

    if (!this.isCurrent(attempt)) {
      return;
    }

    mergeCaptions(this.store, voiceHistorySchema.parse(result.history));
    this.store.setState({ historyError: "" });
  };

  /** Begin caption observation after mount.
  @returns Cleanup for this owner's history lifetime.
  */
  connect = () => {
    this.isActive = true;
    void this.reload();
    globalThis.addEventListener("pocket-voice-history", this.onHistory);

    return this.disconnect;
  };

  /** Allocate explicit history dependencies without opening requests.
  @param store - Scoped caption state owner.
  @param url - Scoped history endpoint.
  */
  constructor(
    private readonly store: VoiceStore,
    private readonly url: string
  ) {}

  /** Read ownership again after asynchronous work.
  @param attempt - Generation that initiated the request.
  @returns Whether the mounted owner still accepts this result.
  */
  private isCurrent(attempt: number) {
    return this.isActive && this.generation === attempt;
  }
}
