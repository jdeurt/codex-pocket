"use client";
import { t as captureResult } from "try";

import { type VoiceResources, realtimeCommand } from "./realtime-stream";
import { pocketUrl } from "./pockets";

const ANALYSER_FFT_SIZE = 2048;
const ANALYSER_SMOOTHING = 0.72;

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
  };
}

/** Attach remote media directly to native playback and observe it only for the spectrum.
@param current - Live browser resources.
@param event - Remote audio track delivered by WebRTC.
*/
export async function playRemoteAudio(current: VoiceResources, event: RTCTrackEvent) {
  if (!current.active) {
    return;
  }

  const stream = event.streams[0] ?? new MediaStream([event.track]);

  current.remoteSource?.disconnect();
  current.remoteSource = current.context.createMediaStreamSource(stream);
  current.remoteSource.connect(current.outputAnalyser);
  current.output.srcObject = stream;
  await current.output.play();
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

  // Closing a context that was already released is harmless.
  void captureResult(current.context.close());
}

/** Capture native microphone tracks and negotiate their peer connection.
@param current - Resources reserved before asking for microphone permission.
@param fail - Report track loss without retaining microphone resources.
*/
export async function connectVoice(current: VoiceResources, fail: (message: string) => void) {
  const isActive = () => current.active;

  await current.context.resume();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  if (!isActive()) {
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
    track.addEventListener("ended", () => {
      fail("Microphone disconnected. Realtime stopped.");
    });
  }

  const offer = await current.peer.createOffer();

  await current.peer.setLocalDescription(offer);

  if (!isActive()) {
    return;
  }

  if (!offer.sdp) {
    throw new Error("The browser could not create an audio connection.");
  }

  current.startingRequest = realtimeCommand({ action: "start", sdp: offer.sdp }, current.commandUrl);
  const result = await current.startingRequest;

  if (!isActive()) {
    return;
  }

  if (typeof result.token !== "string" || typeof result.sdp !== "string") {
    throw new TypeError("Realtime did not return a valid connection.");
  }

  current.token = result.token;
  current.nativeSessionId = typeof result.nativeSessionId === "string" ? result.nativeSessionId : undefined;
  await current.peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
}
