"use client";
import { t as captureResult } from "try";
import { reportClient, clientError } from "./client-logging";

import { type VoiceResources, realtimeCommand } from "./realtime-stream";
import { pocketUrl } from "./pocket-navigation";

const ANALYSER_FFT_SIZE = 2048;
const ANALYSER_SMOOTHING = 0.72;
const ICE_TIMEOUT_MS = 10_000;

/** Create native WebRTC transport and visualization nodes without capturing or queuing PCM.
@param context - Audio context activated by the user's gesture.
@returns Resources owned by one browser voice session.
*/
export function createVoiceResources(context: AudioContext): VoiceResources {
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel("oai-events");
  const output = document.createElement("audio");
  const inputAnalyser = context.createAnalyser();
  const outputAnalyser = context.createAnalyser();

  output.autoplay = true;
  output.setAttribute("playsinline", "");

  for (const analyser of [inputAnalyser, outputAnalyser]) {
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
  }

  return {
    commandUrl: pocketUrl("/api/realtime"),
    eventsUrl: pocketUrl("/api/realtime/events"),
    context,
    peer,
    channel,
    output,
    inputAnalyser,
    outputAnalyser,
    abort: new AbortController(),
    active: true,
    stopping: false,
  };
}

/** Attach remote media directly to native playback and observe it only for the spectrum.
@param current - Live browser resources.
@param event - Remote audio track delivered by WebRTC.
*/
export async function playRemoteAudio(current: VoiceResources, event: RTCTrackEvent) {
  if (!current.active || current.stopping) {
    return;
  }

  const stream = event.streams[0] ?? new MediaStream([event.track]);

  current.remoteSource?.disconnect();
  current.remoteSource = current.context.createMediaStreamSource(stream);
  current.remoteSource.connect(current.outputAnalyser);
  current.output.srcObject = stream;
  await current.output.play();
}

/** Close the native audio context and report cleanup failures without delaying local release.
@param context - Audio context whose media has already been disconnected.
*/
async function closeAudioContext(context: AudioContext) {
  if (context.state === "closed") {
    return;
  }

  const closed = await captureResult(context.close.bind(context));

  if (!closed.ok) {
    reportClient("realtime.audio_close_failed", clientError(closed.error), "error");
  }
}

/** Read current ownership after an asynchronous media operation.
@param current - Session resources supplied by their runtime owner.
@returns Whether the call still owns its media.
*/
function isVoiceActive(current: VoiceResources) {
  return current.active && !current.stopping;
}

/** Resume spectrum processing without making native capture wait for browser playback policy.
@param current - Resources whose audio context is used only for visualization.
*/
async function resumeVoiceSpectrum(current: VoiceResources) {
  const resumed = await captureResult(current.context.resume.bind(current.context));

  if (!resumed.ok && isVoiceActive(current)) {
    reportClient("realtime.spectrum_resume_failed", clientError(resumed.error), "error");
  }
}

/** Mute local media immediately while keeping final session metadata receivable.
@param current - Resources whose remote session is being finalized.
*/
export function quiesceVoiceResources(current: VoiceResources) {
  current.stopping = true;
  clearTimeout(current.connectionTimer);
  current.output.pause();

  if (!current.startingRequest) {
    current.abort.abort();
  }

  const tracks = current.stream?.getTracks() ?? [];

  for (const track of tracks) {
    track.enabled = false;
    track.stop();
  }
}

/** Complete an ICE waiter only after the native offer contains gathered candidates.
@param peer - Native negotiation owner.
@param pending - The exact pending gathering lifetime.
*/
function gatheredIce(peer: RTCPeerConnection, pending: PromiseWithResolvers<undefined>) {
  if (peer.iceGatheringState === "complete") {
    pending.resolve(undefined);
  }
}

/** Cancel a negotiation waiter when cancelled or its bounded deadline expires.
@param pending - Gathering lifetime whose failure is owned by connectVoice.
*/
function failedIce(pending: PromiseWithResolvers<undefined>) {
  pending.reject(new Error("Live voice candidate gathering was cancelled or timed out."));
}

/** Gather the browser's complete SDP without adding a per-speech-turn wait.
@param current - Native session resources, with cancellation owned by release.
*/
async function gatherVoiceIce(current: VoiceResources) {
  const pending = Promise.withResolvers<undefined>();
  const changed = gatheredIce.bind(undefined, current.peer, pending);
  const failed = failedIce.bind(undefined, pending);

  current.peer.addEventListener("icegatheringstatechange", changed);
  current.abort.signal.addEventListener("abort", failed, { once: true });
  const timer = setTimeout(failed, ICE_TIMEOUT_MS);

  changed();
  const outcome = await captureResult(pending.promise);

  clearTimeout(timer);
  current.peer.removeEventListener("icegatheringstatechange", changed);
  current.abort.signal.removeEventListener("abort", failed);

  if (!outcome.ok) {
    throw outcome.error;
  }
}

/** Release microphone and playback synchronously, before waiting for server cleanup.
@param current - Resources to revoke on stop, failure, navigation or cancellation.
*/
export function releaseVoiceResources(current: VoiceResources) {
  current.active = false;
  clearTimeout(current.connectionTimer);
  current.abort.abort();
  current.channel.close();
  current.peer.close();
  current.output.pause();
  current.output.srcObject = null;
  current.source?.disconnect();
  current.remoteSource?.disconnect();
  current.inputAnalyser.disconnect();
  current.outputAnalyser.disconnect();

  const tracks = current.stream?.getTracks() ?? [];

  for (const track of tracks) {
    track.stop();
  }

  void closeAudioContext(current.context);
}

/** Capture native microphone tracks and negotiate their peer connection.
@param current - Resources reserved before asking for microphone permission.
@param fail - Report track loss without retaining microphone resources.
*/
export async function connectVoice(current: VoiceResources, fail: (message: string) => void) {
  void resumeVoiceSpectrum(current);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  if (!isVoiceActive(current)) {
    for (const track of stream.getTracks()) {
      track.stop();
    }

    return;
  }

  current.stream = stream;
  current.source = current.context.createMediaStreamSource(stream);
  current.source.connect(current.inputAnalyser);

  for (const track of stream.getAudioTracks()) {
    current.peer.addTrack(track, stream);
    track.addEventListener("ended", fail.bind(undefined, "Microphone disconnected. Realtime stopped."));
  }

  const offer = await current.peer.createOffer();

  await current.peer.setLocalDescription(offer);
  await gatherVoiceIce(current);

  if (!isVoiceActive(current)) {
    return;
  }

  const sdp = current.peer.localDescription?.sdp;

  if (!sdp) {
    throw new Error("The browser could not create an audio connection.");
  }

  current.startingRequest = realtimeCommand({ action: "start", sdp }, current.commandUrl);
  const result = await current.startingRequest;

  if (!isVoiceActive(current)) {
    return;
  }

  if (typeof result.token !== "string" || typeof result.sdp !== "string") {
    throw new TypeError("Realtime did not return a valid connection.");
  }

  current.token = result.token;
  current.nativeSessionId = typeof result.nativeSessionId === "string" ? result.nativeSessionId : undefined;
  await current.peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
}
