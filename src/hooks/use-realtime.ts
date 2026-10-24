"use client";
import { type VoiceResources, listenRealtime, stopRealtime, receiveRealtime } from "@/lib/realtime-stream";
import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceResources, connectVoice, playRemoteAudio, releaseVoiceResources } from "@/lib/realtime-capture";
import { useVoiceTranscripts } from "./use-voice-transcripts";

const MEDIA_CONNECT_TIMEOUT_MS = 45_000;

type VoiceState = "idle" | "starting" | "active" | "stopping";

/** Own a direct browser-to-OpenAI audio connection and separate history/control feed.
@param threadId - Connected Pocket whose saved voice history is displayed.
@returns Voice state, lifecycle controls and spectrum nodes.
*/
export function useRealtime(threadId?: string) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const history = useVoiceTranscripts(threadId);
  const { refresh, transcript } = history;
  const resources = useRef<VoiceResources | null>(null);
  const stopTask = useRef<Promise<void> | null>(null);

  const stop = useCallback(async () => {
    if (stopTask.current) {
      return stopTask.current;
    }

    const current = resources.current;

    if (!current) {
      return;
    }

    resources.current = null;
    releaseVoiceResources(current);
    setState("stopping");
    const task = async () => {
      try {
        await stopRealtime(current);
      } catch {
        setError("Realtime closure could not be confirmed.");
      } finally {
        stopTask.current = null;
        setState("idle");
        void refresh().catch(() => {
          setError("Voice history could not be refreshed.");
        });
      }
    };

    stopTask.current = task();
    await stopTask.current;
  }, [refresh]);

  const start = useCallback(async () => {
    if (resources.current || stopTask.current) {
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

    resources.current = current;
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
    current.peer.addEventListener("track", (event) => {
      void playRemoteAudio(current, event).catch(() => {
        fail("Audio playback could not start. Start voice again to continue.");
      });
    });
    current.channel.addEventListener("close", () => {
      fail("Realtime disconnected. Start voice again to continue.");
    });

    const connect = async () => {
      await connectVoice(current, fail);

      if (!current.active || !current.token) {
        return;
      }

      void listenRealtime(current, current.token, (message) => {
        receiveRealtime(current, message, { stop: () => void stop(), error: setError, transcript });
      }).catch(() => {
        if (current.active) {
          setError("Reply text disconnected. Your live audio is still connected.");
        }
      });
    };

    try {
      await connect();
    } catch (error_) {
      fail(error_ instanceof Error ? error_.message : "Realtime could not start.");
    }
  }, [stop, transcript]);

  useEffect(
    () => () => {
      void stop();
    },
    [stop]
  );

  return {
    state,
    error: error || history.error,
    segments: history.segments,
    dismissError: () => {
      setError("");
      history.dismissError();
    },
    start,
    stop,
    inputAnalyser: resources.current?.inputAnalyser,
    outputAnalyser: resources.current?.outputAnalyser,
  };
}
