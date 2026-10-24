import { type Data } from "../lib/protocol";
import { z } from "zod";
import { liveTranscriptSchema } from "./realtime-captions";

const MILLISECONDS = 1000;
const OUTPUT_GROUP_GAP_MS = 1500;
const audioStatsSchema = z.object({
  type: z.literal("inbound-rtp"),
  kind: z.literal("audio").optional(),
  mediaType: z.literal("audio").optional(),
  jitterBufferDelay: z.number().optional(),
  jitterBufferEmittedCount: z.number().optional(),
  packetsReceived: z.number().optional(),
  packetsLost: z.number().optional(),
});

export interface VoiceTimingState {
  inputEndMs?: number;
  inputReceivedAt?: number;
  outputEndMs?: number;
}
export interface VoiceTimingSample extends Data {
  phase: "output_transcript_started";
  mediaStartMs: number;
  mediaEndMs: number;
  inputCaptionToOutputCaptionMs?: number;
  mediaGapMs?: number;
}

/** Create one call's content-free timing state without inventing spoken-response boundaries.
@returns Empty native timestamp observations.
*/
export function voiceTimingState(): VoiceTimingState {
  return {};
}

/** Observe transcript receipt and media timing independently of acoustic playback.
@param state - Previous call-local observations.
@param event - GPT-Live metadata event, never raw audio.
@param now - Explicit browser monotonic receipt time.
@returns Next observations and one diagnostic at the start of an approximate output group.
*/
export function receivedVoiceTiming(
  state: VoiceTimingState,
  event: Data,
  now: number
): { state: VoiceTimingState; sample?: VoiceTimingSample } {
  const parsed = liveTranscriptSchema.safeParse(event);

  if (!parsed.success) {
    return { state };
  }

  const fragment = parsed.data;

  if (fragment.type === "session.input_transcript.delta") {
    return { state: { ...state, inputEndMs: fragment.end_ms, inputReceivedAt: now } };
  }

  const isNew = state.outputEndMs === undefined || fragment.start_ms - state.outputEndMs > OUTPUT_GROUP_GAP_MS;
  const next = { ...state, outputEndMs: Math.max(state.outputEndMs ?? 0, fragment.end_ms) };

  return {
    state: next,
    ...(isNew && {
      sample: {
        phase: "output_transcript_started",
        mediaStartMs: fragment.start_ms,
        mediaEndMs: fragment.end_ms,
        ...(state.inputEndMs !== undefined && { mediaGapMs: fragment.start_ms - state.inputEndMs }),
        ...(state.inputReceivedAt !== undefined && { inputCaptionToOutputCaptionMs: now - state.inputReceivedAt }),
      } satisfies VoiceTimingSample,
    }),
  };
}

/** Read a browser's cumulative audio jitter-buffer counters without retaining network addresses.
@param reports - Detached native WebRTC statistics.
@returns Audio packet counters and cumulative average jitter-buffer delay when available.
*/
export function voiceAudioStats(reports: unknown[]): Data {
  for (const report of reports) {
    const parsed = audioStatsSchema.safeParse(report);

    if (!parsed.success || !(parsed.data.kind || parsed.data.mediaType)) {
      continue;
    }

    const stats = parsed.data;
    const count = stats.jitterBufferEmittedCount;

    return {
      packetsReceived: stats.packetsReceived,
      packetsLost: stats.packetsLost,
      ...(count !== undefined &&
        count > 0 &&
        stats.jitterBufferDelay !== undefined && {
          jitterBufferAverageMs: (MILLISECONDS * stats.jitterBufferDelay) / count,
        }),
    };
  }

  return {};
}
