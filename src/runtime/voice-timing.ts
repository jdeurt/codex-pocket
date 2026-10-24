import { t } from "try";
import { dataSchema } from "../lib/protocol";
import { receivedVoiceTiming, voiceAudioStats, voiceTimingState, type VoiceTimingSample } from "../state/voice-timing";
import { observable } from "./stores";
import { reportClient } from "./client-logging";
import { type VoiceResources } from "./realtime-stream";

/**
Observe metadata and native receiver statistics independently of audio playback and captions.
*/
export class VoiceTiming {
  private readonly store = observable(voiceTimingState());

  /** Consume only metadata from the native provider data channel.
  @param event - Native channel message; its text is never copied to diagnostics.
  */
  receive = (event: MessageEvent<unknown>) => {
    if (!this.resources.active || typeof event.data !== "string") {
      return;
    }

    const decoded = t(JSON.parse, event.data);
    const parsed = dataSchema.safeParse(decoded.ok ? decoded.value : undefined);

    if (!parsed.success) {
      return;
    }

    const received = receivedVoiceTiming(this.store.getState(), parsed.data, performance.now());

    this.store.setState(received.state, true);

    if (received.sample) {
      void this.report(received.sample);
    }
  };

  /** Bind diagnostics to exactly one call's native media resources.
  @param resources - Owning browser connection, revoked synchronously on stop.
  */
  constructor(private readonly resources: VoiceResources) {}

  /** Report at most two milestones per response; no per-delta logging or media waits.
  @param sample - Content-free receipt timings from the pure projection.
  */
  private async report(sample: VoiceTimingSample) {
    const stats =
      sample.phase === "audio_started" ? await t(this.resources.peer.getStats.bind(this.resources.peer)) : undefined;

    if (!this.resources.active) {
      return;
    }

    reportClient("realtime.response_timing", {
      ...sample,
      audioElementPaused: this.resources.output.paused,
      audioElementReadyState: this.resources.output.readyState,
      audioContextState: this.resources.context.state,
      ...(stats?.ok && voiceAudioStats(stats.value.values().toArray())),
    });
  }
}
