"use client";
/* eslint-disable @typescript-eslint/no-magic-numbers, jsdoc/require-returns, unicorn/try-complexity, complexity, @typescript-eslint/no-deprecated -- Web Audio capture is a sequential resource lifecycle; ScriptProcessor supports the current browser fixture and PCM dimensions follow the native protocol. */
import {
  type VoiceResources,
  drainInput,
  flushInput,
  listenRealtime,
  queueInput,
  realtimeCommand,
  receiveRealtime,
} from "@/lib/realtime-stream";
import { useCallback, useEffect, useRef, useState } from "react";
import { createVoiceResources } from "@/lib/realtime-capture";
import { pcm16 } from "@/lib/realtime-audio";
import { useVoiceTranscripts } from "./use-voice-transcripts";

type VoiceState = "idle" | "starting" | "active" | "stopping";

/**
Own one browser microphone/playback pipeline and release it on every exit path.
*/
export function useRealtime() {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const history = useVoiceTranscripts();
  const { refresh, transcript, handoff } = history;
  const resources = useRef<VoiceResources | null>(null);
  const pendingStream = useRef<MediaStream | null>(null);
  const pendingContext = useRef<AudioContext | null>(null);
  const captureCleanup = useRef<(() => void) | null>(null);
  const stopping = useRef(false);
  const stopTask = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);

  const stop = useCallback(
    async (shouldDrain = true) => {
      if (stopTask.current) {
        return stopTask.current;
      }

      generation.current++;
      starting.current = false;
      const current = resources.current;
      const waitingStream = pendingStream.current;
      const waitingContext = pendingContext.current;

      pendingStream.current = null;
      pendingContext.current = null;
      captureCleanup.current?.();
      captureCleanup.current = null;

      if (waitingStream) {
        for (const track of waitingStream.getTracks()) {
          track.stop();
        }
      }

      if (waitingContext) {
        void waitingContext.close().catch(() => {
          // The context may already be closing.
        });
      }

      if (!current || stopping.current) {
        setState("idle");

        return;
      }

      stopping.current = true;
      setState("stopping");
      resources.current = null;
      current.active = false;
      current.draining = shouldDrain;

      if (current.inputTimer) {
        clearTimeout(current.inputTimer);
      }

      if (current.outputTimer) {
        clearTimeout(current.outputTimer);
      }

      if (shouldDrain && current.token) {
        flushInput(current, () => {
          // The stop task reports the captured input error after the queue settles.
        });
      } else {
        current.inputParts = [];
      }

      current.outputParts = [];
      current.processor.onaudioprocess = null;
      current.processor.disconnect();
      current.source.disconnect();
      current.inputAnalyser.disconnect();
      current.outputAnalyser.disconnect();

      for (const source of current.outputSources) {
        source.stop();
        source.disconnect();
      }

      current.outputSources.clear();

      for (const track of current.stream.getTracks()) {
        track.stop();
      }

      const task = (async () => {
        try {
          if (current.draining) {
            try {
              await drainInput(current);
            } catch (error_) {
              setError(error_ instanceof Error ? error_.message : "Audio delivery failed before stopping.");
            }

            current.draining = false;
          }

          const started = current.startingRequest ? await current.startingRequest : undefined;
          const token = current.token ?? (typeof started?.token === "string" ? started.token : undefined);

          if (token) {
            await realtimeCommand({ action: "stop", token }, current.commandUrl);
            await refresh();
          }
        } catch (error_) {
          setError(error_ instanceof Error ? error_.message : "Realtime closure was not confirmed.");
        } finally {
          current.abort.abort();
          void current.context.close().catch(() => {
            // The context may already be closing.
          });
          stopping.current = false;
          stopTask.current = null;
          setState("idle");
        }
      })();

      stopTask.current = task;
      await task;
    },
    [refresh]
  );

  const receive = useCallback(
    (current: VoiceResources, message: Record<string, unknown>) => {
      receiveRealtime(current, message, {
        active: () => {
          setState("active");
        },
        error: setError,
        stop: () => void stop(false),
        transcript,
        handoff,
      });
    },
    [stop, transcript, handoff]
  );

  const start = useCallback(async () => {
    if (state !== "idle" || resources.current || starting.current) {
      return;
    }

    starting.current = true;
    const attempt = ++generation.current;

    setError("");
    setState("starting");
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;

    try {
      if (
        !("mediaDevices" in navigator) ||
        !("getUserMedia" in navigator.mediaDevices) ||
        !("AudioContext" in globalThis)
      ) {
        throw new Error("Realtime audio is unavailable in this browser.");
      }

      // Start playback while the gesture still owns browser user activation (notably Safari).
      context = new AudioContext();
      pendingContext.current = context;
      void context.resume().catch(() => {
        // A second resume after microphone permission reports the actual playback result.
      });

      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pendingStream.current = stream;

      if (generation.current !== attempt) {
        for (const track of stream.getTracks()) {
          track.stop();
        }

        return;
      }

      const capture = stream;
      const lostCapture = () => {
        if (
          generation.current !== attempt ||
          (pendingStream.current !== capture && resources.current?.stream !== capture)
        ) {
          return;
        }

        setError("Microphone disconnected. Realtime stopped.");
        void stop(false);
      };

      for (const track of capture.getAudioTracks()) {
        track.addEventListener("ended", lostCapture);
      }

      capture.addEventListener("inactive", lostCapture);
      captureCleanup.current = () => {
        for (const track of capture.getAudioTracks()) {
          track.removeEventListener("ended", lostCapture);
        }

        capture.removeEventListener("inactive", lostCapture);
      };

      await context.resume();

      if (generation.current !== attempt) {
        for (const track of stream.getTracks()) {
          track.stop();
        }

        void context.close();

        return;
      }

      const sampleRate = context.sampleRate;
      const processor = context.createScriptProcessor(4096, 1, 1);
      const current = createVoiceResources(context, stream, processor);

      resources.current = current;
      pendingStream.current = null;
      pendingContext.current = null;
      current.processor.onaudioprocess = (event) => {
        if (!current.active || !current.ready || !current.token || resources.current !== current) {
          return;
        }

        const audio = pcm16(event.inputBuffer.getChannelData(0), sampleRate);

        queueInput(current, audio.data, audio.samplesPerChannel, (error_: unknown) => {
          if (!current.active) {
            return;
          }

          setError(error_ instanceof Error ? error_.message : "Audio connection failed.");
          void stop(false);
        });
      };
      const request = realtimeCommand({ action: "start" }, current.commandUrl);

      current.startingRequest = request;
      const result = await request;

      if (!current.active || generation.current !== attempt) {
        return;
      }

      if (typeof result.token !== "string") {
        throw new TypeError("Realtime did not return a session token.");
      }

      current.token = result.token;
      current.nativeSessionId = typeof result.nativeSessionId === "string" ? result.nativeSessionId : undefined;
      starting.current = false;
      void listenRealtime(current, result.token, (message) => {
        receive(current, message);
      }).catch((error_: unknown) => {
        if (!current.active) {
          return;
        }

        setError(error_ instanceof Error ? error_.message : "Realtime disconnected.");
        void stop(false);
      });
    } catch (error_) {
      starting.current = false;

      if (generation.current !== attempt) {
        return;
      }

      if (resources.current) {
        void stop(false);
      } else {
        captureCleanup.current?.();
        captureCleanup.current = null;

        if (stream) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
        }

        if (context) {
          void context.close();
        }

        setState("idle");
      }

      setError(error_ instanceof Error ? error_.message : "Realtime could not start.");
    }
  }, [receive, state, stop]);

  useEffect(
    () => () => {
      void stop(false);
    },
    [stop]
  );

  return {
    state,
    error: error || history.error,
    segments: history.segments,
    start,
    stop,
    inputAnalyser: resources.current?.inputAnalyser,
    outputAnalyser: resources.current?.outputAnalyser,
  };
}
