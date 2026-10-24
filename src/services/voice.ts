import { t } from "try";
import { type VoiceResources, stopRealtime } from "../runtime/realtime-stream";
import { createVoiceResources, releaseVoiceResources } from "../runtime/realtime-capture";
import { type VoiceStore } from "../runtime/stores";
import { CaptionHistory } from "./voice-history";
import { VoiceCall } from "./voice-call";

/**
Runtime owner of media resource allocation and the single in-flight stop operation.
*/
export class VoiceController {
  private call: VoiceCall | null = null;
  private stopTask: Promise<void> | null = null;

  /**
  Refresh captions after shutdown without making audio wait on storage.
  */
  private refreshHistory = async () => {
    const refreshed = await t(this.history.refresh);

    if (!refreshed.ok) {
      this.store.setState({ error: "Voice history could not be refreshed." });
    }
  };

  /** Confirm remote shutdown after local media has already been released.
  @param current - Released media resources for the closing call.
  */
  private finishStop = async (current: VoiceResources) => {
    const stopped = await t(stopRealtime, current);

    this.stopTask = null;
    this.store.setState({ state: "idle" });

    if (!stopped.ok) {
      this.store.setState({ error: "Realtime closure could not be confirmed." });
    }

    void this.refreshHistory();
  };

  /**
  Schedule shutdown from a synchronous browser callback.
  */
  private cancel = () => {
    void this.stop();
  };

  /**
  Allocate media before asynchronous negotiation.
  @returns Newly allocated runtime call.
  */
  private createCall = () => {
    if (
      !("RTCPeerConnection" in globalThis) ||
      !("AudioContext" in globalThis) ||
      !("mediaDevices" in navigator) ||
      !("getUserMedia" in navigator.mediaDevices)
    ) {
      throw new Error("Realtime audio is unavailable in this browser.");
    }

    const resources = createVoiceResources(new AudioContext());

    resources.commandUrl = this.url;
    resources.eventsUrl = this.eventsUrl;

    return new VoiceCall(resources, this.store, this.cancel);
  };

  readonly history;

  /** Release local playback immediately, then confirm remote closure.
  @returns Shared completion for simultaneous stop requests.
  */
  stop = async () => {
    if (this.stopTask) {
      return this.stopTask;
    }

    const current = this.call?.resources;

    if (!current) {
      return;
    }

    this.call = null;
    releaseVoiceResources(current);
    this.store.setState({ state: "stopping" });
    this.stopTask = this.finishStop(current);
    await this.stopTask;
  };

  /**
  Start a single native media connection and capture allocation/negotiation failures.
  */
  start = async () => {
    if (this.hasConnection()) {
      return;
    }

    this.store.setState({ error: "", state: "starting" });
    const allocated = t(this.createCall);

    if (!allocated.ok) {
      this.store.setState({
        state: "idle",
        error: allocated.error instanceof Error ? allocated.error.message : "Realtime could not start.",
      });

      return;
    }

    const current = allocated.value;

    this.call = current;
    const connected = await t(current.connect);

    if (connected.ok || !current.resources.active) {
      return;
    }

    this.store.setState({
      error: connected.error instanceof Error ? connected.error.message : "Realtime could not start.",
    });
    await this.stop();
  };

  /**
  Clear user-visible voice warnings.
  */
  dismissError = () => {
    this.store.setState({ error: "", historyError: "" });
  };

  /** Expose browser analysers to the rendering boundary.
  @returns Current input and output analyser handles.
  */
  analysers = () => ({
    inputAnalyser: this.call?.resources.inputAnalyser,
    outputAnalyser: this.call?.resources.outputAnalyser,
  });

  /** Allocate independent media and caption owners without opening a connection.
  @param store - Scoped voice projection.
  @param url - Lifecycle API endpoint.
  @param eventsUrl - Independent transcript endpoint.
  */
  constructor(
    private readonly store: VoiceStore,
    private readonly url: string,
    private readonly eventsUrl: string
  ) {
    this.history = new CaptionHistory(store, url);
  }

  /** Read live ownership without assuming asynchronous operations preserve field values.
  @returns Whether a call or pending stop owns the media runtime.
  */
  private hasConnection() {
    return this.call !== null || this.stopTask !== null;
  }
}
