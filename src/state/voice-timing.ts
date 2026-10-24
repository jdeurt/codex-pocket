import { type Data, object, string } from "../lib/protocol";
import { z } from "zod";

const RESPONSE_LIMIT = 32;
const MILLISECONDS = 1000;
const audioStatsSchema = z.object({
  type: z.literal("inbound-rtp"),
  kind: z.literal("audio").optional(),
  mediaType: z.literal("audio").optional(),
  jitterBufferDelay: z.number().optional(),
  jitterBufferEmittedCount: z.number().optional(),
  packetsReceived: z.number().optional(),
  packetsLost: z.number().optional(),
});

interface ResponseTiming {
  createdAt: number;
  speechStoppedAt?: number;
  captionAt?: number;
  audioAt?: number;
}
export interface VoiceTimingState {
  speechStoppedAt?: number;
  responses: ReadonlyMap<string, ResponseTiming>;
}
export interface VoiceTimingSample extends Data {
  responseId: string;
  phase: "first_caption" | "audio_started";
  responseToEventMs: number;
  speechStopToResponseMs?: number;
  captionLeadMs?: number;
}

/** Create a call-scoped timing ledger containing no speech or transcript text.
@returns Empty response correlations.
*/
export function voiceTimingState(): VoiceTimingState {
  return { responses: new Map() };
}

/** Select timing differences using only one browser's monotonic clock.
@param responseId - Provider response identity.
@param phase - First caption or provider audio-buffer start.
@param timing - Explicit browser-observed milestones.
@param now - Current event receipt time.
@returns Content-free diagnostic fields; audio-buffer start is not a measurement of audible sound.
*/
function timingSample(
  responseId: string,
  phase: VoiceTimingSample["phase"],
  timing: ResponseTiming,
  now: number
): VoiceTimingSample {
  return {
    responseId,
    phase,
    responseToEventMs: now - timing.createdAt,
    ...(timing.speechStoppedAt !== undefined && { speechStopToResponseMs: timing.createdAt - timing.speechStoppedAt }),
    ...(timing.captionAt !== undefined &&
      timing.audioAt !== undefined && { captionLeadMs: timing.audioAt - timing.captionAt }),
  };
}

/** Observe provider milestones without retaining text or changing playback decisions.
@param state - Previous call-local timing state.
@param event - Provider data-channel event.
@param now - Explicit monotonic browser receipt time.
@returns Next ledger and at most one diagnostic sample for this event.
*/
export function receivedVoiceTiming(
  state: VoiceTimingState,
  event: Data,
  now: number
): { state: VoiceTimingState; sample?: VoiceTimingSample } {
  if (event.type === "input_audio_buffer.speech_stopped") {
    return { state: { ...state, speechStoppedAt: now } };
  }

  if (event.type === "input_audio_buffer.speech_started") {
    return { state: { ...state, speechStoppedAt: undefined } };
  }

  if (event.type === "response.created") {
    const id = string(object(event.response).id);

    if (!id || state.responses.has(id)) {
      return { state };
    }

    const responses = new Map(state.responses);

    responses.set(id, { createdAt: now, speechStoppedAt: state.speechStoppedAt });

    if (responses.size > RESPONSE_LIMIT) {
      responses.delete(responses.keys().next().value ?? "");
    }

    return { state: { responses, speechStoppedAt: undefined } };
  }

  const responseId = string(event.response_id);
  const previous = state.responses.get(responseId);

  if (!previous) {
    return { state };
  }

  let phase: VoiceTimingSample["phase"];
  let timing: ResponseTiming;

  if (event.type === "response.output_audio_transcript.delta" && previous.captionAt === undefined) {
    phase = "first_caption";
    timing = { ...previous, captionAt: now };
  } else if (event.type === "output_audio_buffer.started" && previous.audioAt === undefined) {
    phase = "audio_started";
    timing = { ...previous, audioAt: now };
  } else {
    return { state };
  }

  const responses = new Map(state.responses);

  responses.set(responseId, timing);

  return { state: { ...state, responses }, sample: timingSample(responseId, phase, timing, now) };
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
