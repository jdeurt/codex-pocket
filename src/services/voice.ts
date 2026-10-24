import { t as captureResult } from "try";
import { type VoiceResources, listenRealtime, stopRealtime, receiveRealtime } from "../lib/realtime-stream";
import { createVoiceResources, connectVoice, playRemoteAudio, releaseVoiceResources } from "../lib/realtime-capture";
import { type VoiceStore, type VoicePhase, mergeCaptions } from "../state/voice";
import { createCaptionHistory } from "./voice-history";

const MEDIA_CONNECT_TIMEOUT_MS = 45_000;

/** Own browser media resources separately from observable lifecycle and caption state.
@param store - Scoped voice state.
@param url - Scoped lifecycle API URL.
@param eventsUrl - Scoped passive caption feed.
@returns Actions and resource accessors; construction has no browser side effects.
*/
export function createVoiceController(store: VoiceStore, url: string, eventsUrl: string) {
  const history = createCaptionHistory(store, url);
  const { refresh } = history;
  const transcript = (entry: Parameters<typeof mergeCaptions>[1][number]) => {
    mergeCaptions(store, [entry]);
  };
  const setState = (state: VoicePhase) => {
    store.setState({ state });
  };
  const setError = (error: string) => {
    store.setState({ error });
  };

  let resources: VoiceResources | null = null;
  let stopTask: Promise<void> | null = null;

  async function refreshHistory() {
    const refreshed = await captureResult(refresh);

    if (!refreshed.ok) {
      setError("Voice history could not be refreshed.");
    }
  }

  async function finishStop(current: VoiceResources) {
    const stopped = await captureResult(stopRealtime, current);

    stopTask = null;
    setState("idle");

    if (!stopped.ok) {
      setError("Realtime closure could not be confirmed.");
    }

    void refreshHistory();
  }

  const stop = async () => {
    if (stopTask) {
      return stopTask;
    }

    const current = resources;

    if (!current) {
      return;
    }

    resources = null;
    releaseVoiceResources(current);
    setState("stopping");
    stopTask = finishStop(current);
    await stopTask;
  };

  const start = async () => {
    if (resources || stopTask) {
      return;
    }

    setError("");
    setState("starting");

    if (
      !("RTCPeerConnection" in globalThis) ||
      !("AudioContext" in globalThis) ||
      !("mediaDevices" in navigator) ||
      !("getUserMedia" in navigator.mediaDevices)
    ) {
      setError("Realtime audio is unavailable in this browser.");
      setState("idle");

      return;
    }

    const context = new AudioContext();
    const current = createVoiceResources(context);

    current.commandUrl = url;
    current.eventsUrl = eventsUrl;

    resources = current;
    const fail = (message: string) => {
      if (!current.active) {
        return;
      }

      setError(message);
      void stop();
    };

    current.connectionTimer = setTimeout(() => {
      fail("Realtime audio could not connect. Start voice again to continue.");
    }, MEDIA_CONNECT_TIMEOUT_MS);
    current.peer.addEventListener("connectionstatechange", () => {
      if (!current.active) {
        return;
      }

      if (current.peer.connectionState === "connected") {
        clearTimeout(current.connectionTimer);
        setState("active");
      } else if (["failed", "closed"].includes(current.peer.connectionState)) {
        fail("Realtime audio disconnected. Start voice again to continue.");
      }
    });

    async function play(event: RTCTrackEvent) {
      const played = await captureResult(playRemoteAudio, current, event);

      if (!played.ok) {
        fail("Audio playback could not start. Start voice again to continue.");
      }
    }

    current.peer.addEventListener("track", (event) => void play(event));
    current.channel.addEventListener("close", () => {
      fail("Realtime disconnected. Start voice again to continue.");
    });

    async function followCaptions(token: string) {
      const listened = await captureResult(listenRealtime, current, token, (message) => {
        receiveRealtime(current, message, { stop: () => void stop(), error: setError, transcript });
      });

      if (!listened.ok && current.active) {
        setError("Reply text disconnected. Your live audio is still connected.");
      }
    }

    const connect = async () => {
      await connectVoice(current, fail);

      if (current.active && current.token) {
        void followCaptions(current.token);
      }
    };

    const completed = await captureResult(connect());

    if (completed.ok) {
      return;
    }

    const error_ = completed.error;

    fail(error_ instanceof Error ? error_.message : "Realtime could not start.");
  };

  return {
    start,
    stop,
    history,
    dismissError: () => {
      store.setState({ error: "", historyError: "" });
    },
    analysers: () => ({ inputAnalyser: resources?.inputAnalyser, outputAnalyser: resources?.outputAnalyser }),
  };
}
