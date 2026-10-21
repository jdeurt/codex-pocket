"use client";
import { type VoiceResources } from "./realtime-stream";
import { pocketUrl } from "./pockets";

const ANALYSER_FFT_SIZE = 2048;
const ANALYSER_SMOOTHING = 0.72;
const SILENT_GAIN = 0;

/**
Build the browser capture and playback graph for one native session.
@param context - Audio context activated by the user's gesture.
@param stream - Captured microphone stream.
@param processor - Capture processor created under the browser gesture.
@returns Browser resources bound to the selected Pocket URLs.
*/
export function createVoiceResources(
  context: AudioContext,
  stream: MediaStream,
  processor: VoiceResources["processor"]
): VoiceResources {
  const source = context.createMediaStreamSource(stream);
  const inputAnalyser = context.createAnalyser();
  const outputAnalyser = context.createAnalyser();
  const silent = context.createGain();

  inputAnalyser.fftSize = ANALYSER_FFT_SIZE;
  inputAnalyser.smoothingTimeConstant = ANALYSER_SMOOTHING;

  outputAnalyser.fftSize = ANALYSER_FFT_SIZE;
  outputAnalyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
  outputAnalyser.connect(context.destination);

  silent.gain.value = SILENT_GAIN;
  source.connect(inputAnalyser);
  inputAnalyser.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);

  return {
    commandUrl: pocketUrl("/api/realtime"),
    eventsUrl: pocketUrl("/api/realtime/events"),
    context,
    stream,
    source,
    processor,
    inputAnalyser,
    outputAnalyser,
    outputTime: 0,
    outputSources: new Set(),
    outputParts: [],
    outputSamples: 0,
    abort: new AbortController(),
    sending: Promise.resolve(),
    inputParts: [],
    inputSamples: 0,
    pendingSamples: 0,
    draining: false,
    active: true,
    ready: false,
  };
}
