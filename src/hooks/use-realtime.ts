"use client";
/* eslint-disable jdeurt/const-on-top, @typescript-eslint/no-magic-numbers, jsdoc/require-returns, unicorn/try-complexity, complexity, @typescript-eslint/no-deprecated, unicorn/prefer-await -- Web Audio capture is a sequential resource lifecycle; ScriptProcessor supports the current browser fixture and PCM dimensions follow the native protocol. */
import {
  type VoiceResources,
  type VoiceSegment,
  listenRealtime,
  realtimeCommand,
  receiveRealtime,
} from "@/lib/realtime-stream";
import { useCallback, useEffect, useRef, useState } from "react";
import { pcm16 } from "@/lib/realtime-audio";

type VoiceState = "idle" | "starting" | "active";

/**
Own one browser microphone/playback pipeline and release it on every exit path.
*/
export function useRealtime() {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const [segments, setSegments] = useState<VoiceSegment[]>([]);
  const resources = useRef<VoiceResources | null>(null);
  const pendingStream = useRef<MediaStream | null>(null);
  const pendingContext = useRef<AudioContext | null>(null);
  const captureCleanup = useRef<(() => void) | null>(null);
  const nextId = useRef(0);
  const stopping = useRef(false);
  const generation = useRef(0);
  const starting = useRef(false);

  const stop = useCallback(async () => {
    generation.current++;
    starting.current = false;
    setSegments((entries) => entries.map((entry) => (entry.done ? entry : { ...entry, done: true })));
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
    resources.current = null;
    current.active = false;
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

    current.abort.abort();
    void current.context.close().catch(() => {
      // Native stop is best effort after local microphone cleanup.
    });
    setState("idle");
    const token = current.token;

    stopping.current = false;

    if (token) {
      try {
        await realtimeCommand({ action: "stop", token });
      } catch {
        /*
        Local tracks are already stopped; server stream abort also stops native.
        */
      }
    }
  }, []);

  const receive = useCallback(
    (current: VoiceResources, message: Record<string, unknown>) => {
      receiveRealtime(current, message, {
        active: () => {
          setState("active");
        },
        error: setError,
        stop: () => void stop(),
        transcript: (role, text, done, sessionId) => {
          setSegments((entries) => {
            const index = entries.findLastIndex(
              (entry) => entry.role === role && !entry.done && entry.nativeSessionId === sessionId
            );

            return index === -1
              ? [...entries, { id: ++nextId.current, role, text, done, nativeSessionId: sessionId }]
              : entries.map((entry, at) =>
                  at === index ? { ...entry, text: done ? text : entry.text + text, done } : entry
                );
          });
        },
      });
    },
    [stop]
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
        void stop();
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

      const source = context.createMediaStreamSource(stream);
      const inputAnalyser = context.createAnalyser();

      inputAnalyser.fftSize = 2048;
      inputAnalyser.smoothingTimeConstant = 0.72;
      const outputAnalyser = context.createAnalyser();

      outputAnalyser.fftSize = 2048;
      outputAnalyser.smoothingTimeConstant = 0.72;
      outputAnalyser.connect(context.destination);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const sampleRate = context.sampleRate;
      const silent = context.createGain();

      silent.gain.value = 0;
      source.connect(inputAnalyser);
      inputAnalyser.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      const current: VoiceResources = {
        context,
        stream,
        source,
        processor,
        inputAnalyser,
        outputAnalyser,
        outputTime: 0,
        outputSources: new Set(),
        abort: new AbortController(),
        sending: Promise.resolve(),
        queuedChunks: 0,
        active: true,
        ready: false,
      };

      resources.current = current;
      pendingStream.current = null;
      pendingContext.current = null;
      processor.onaudioprocess = (event) => {
        if (!current.active || !current.ready || !current.token || resources.current !== current) {
          return;
        }

        if (++current.queuedChunks > 8) {
          setError("Audio connection is too slow.");
          void stop();

          return;
        }

        const audio = pcm16(event.inputBuffer.getChannelData(0), sampleRate);

        current.sending = current.sending
          .then(() => (current.active ? realtimeCommand({ action: "audio", token: current.token, audio }) : undefined))
          .catch((error_: unknown) => {
            if (!current.active) {
              return;
            }

            setError(error_ instanceof Error ? error_.message : "Audio connection failed.");
            void stop();
          })
          .finally(() => {
            current.queuedChunks--;
          });
      };
      const result = await realtimeCommand({ action: "start" });

      if (!current.active || generation.current !== attempt) {
        if (typeof result.token === "string") {
          void realtimeCommand({ action: "stop", token: result.token }).catch(() => {
            // The session was already stopped while start was pending.
          });
        }

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
        void stop();
      });
    } catch (error_) {
      starting.current = false;

      if (generation.current !== attempt) {
        return;
      }

      if (resources.current) {
        void stop();
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
      void stop();
    },
    [stop]
  );

  return {
    state,
    error,
    segments,
    start,
    stop,
    inputAnalyser: resources.current?.inputAnalyser,
    outputAnalyser: resources.current?.outputAnalyser,
  };
}
