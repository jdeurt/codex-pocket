import { t } from "try";
import { VoiceTiming } from "../runtime/voice-timing";
import { type VoiceResources, listenRealtime, receiveRealtime } from "../runtime/realtime-stream";
import { connectVoice, playRemoteAudio } from "../runtime/realtime-capture";
import { type VoiceStore, mergeCaptions } from "../runtime/stores";
import { type VoiceSegment } from "../lib/voice-history";

const MEDIA_CONNECT_TIMEOUT_MS = 45_000;

/**
Runtime owner of the callbacks registered for one particular media connection.
*/
export class VoiceCall {
  private readonly timing;
  /** Publish a media error only while this call owns active resources.
  @param message - User-facing failure.
  */
  private fail = (message: string) => {
    if (!this.resources.active) {
      return;
    }

    this.error(message);
    this.stop();
  };

  /**
  Publish the bounded connection timeout.
  */
  private timedOut = () => {
    this.fail("Realtime audio could not connect. Start voice again to continue.");
  };

  /**
  Track the peer's actual connection state.
  */
  private connectionChanged = () => {
    if (!this.resources.active) {
      return;
    }

    if (this.resources.peer.connectionState === "connected") {
      clearTimeout(this.resources.connectionTimer);
      this.store.setState({ state: "active" });
    } else if (["failed", "closed"].includes(this.resources.peer.connectionState)) {
      this.fail("Realtime audio disconnected. Start voice again to continue.");
    }
  };

  /** Attach a remote track to native playback and capture browser playback failures.
  @param event - WebRTC track event owned by this peer.
  */
  private play = async (event: RTCTrackEvent) => {
    const played = await t(playRemoteAudio, this.resources, event);

    if (!played.ok) {
      this.fail("Audio playback could not start. Start voice again to continue.");
    }
  };

  /** Receive a native track callback without creating an unhandled promise.
  @param event - WebRTC track event.
  */
  private track = (event: RTCTrackEvent) => {
    void this.play(event);
  };

  /**
  End a call whose control channel has closed.
  */
  private closed = () => {
    this.fail("Realtime disconnected. Start voice again to continue.");
  };

  /** Publish caption data independently of media playback.
  @param entry - Validated caption event.
  */
  private transcript = (entry: VoiceSegment) => {
    mergeCaptions(this.store, [entry]);
  };

  /** Publish a warning without stopping media for caption-only failures.
  @param error - User-facing warning.
  */
  private error = (error: string) => {
    this.store.setState({ error });
  };

  /** Dispatch one lightweight server control event.
  @param message - Parsed control event.
  */
  private receive = (message: Record<string, unknown>) => {
    receiveRealtime(this.resources, message, { stop: this.stop, error: this.error, transcript: this.transcript });
  };

  /** Follow independent transcript events after audio negotiation.
  @param token - Private token for this call's control stream.
  */
  private followCaptions = async (token: string) => {
    const listened = await t(listenRealtime, this.resources, token, this.receive);

    if (!listened.ok && this.resources.active) {
      this.error("Reply text disconnected. Your live audio is still connected.");
    }
  };

  /** Bind native listeners and negotiate audio directly with the peer.
  @returns Completion of initial negotiation; captions continue independently.
  */
  connect = async () => {
    const current = this.resources;

    current.connectionTimer = setTimeout(this.timedOut, MEDIA_CONNECT_TIMEOUT_MS);
    current.peer.addEventListener("connectionstatechange", this.connectionChanged);
    current.peer.addEventListener("track", this.track);
    current.channel.addEventListener("close", this.closed);
    current.channel.addEventListener("message", this.timing.receive);
    await connectVoice(current, this.fail);

    if (current.active && current.token) {
      void this.followCaptions(current.token);
    }
  };

  /** Bind resources to the exact voice runtime that owns their lifecycle.
  @param resources - Media resources for this call only.
  @param store - Observable voice projection.
  @param stop - Runtime operation that releases this call.
  */
  constructor(
    readonly resources: VoiceResources,
    private readonly store: VoiceStore,
    private readonly stop: () => void
  ) {
    this.timing = new VoiceTiming(resources);
  }
}
