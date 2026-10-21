"use client";
/* eslint-disable jdeurt/const-on-top, @typescript-eslint/no-magic-numbers, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, unicorn/try-complexity, max-lines, complexity, @typescript-eslint/no-deprecated, unicorn/prefer-await -- Web Audio capture is a sequential resource lifecycle; ScriptProcessor supports the current browser fixture and PCM dimensions follow the native protocol. */
import { useCallback, useEffect, useRef, useState } from "react";
import { dataSchema } from "@/lib/protocol";
import { pocketUrl } from "@/lib/pockets";
import { z } from "zod";

interface Segment {
  id: number;
  role: "user" | "assistant";
  text: string;
  done: boolean;
}
type VoiceState = "idle" | "starting" | "active";
const TARGET_RATE = 24_000;
const outputAudioSchema = z.object({ data: z.string(), sampleRate: z.number(), numChannels: z.number() });

/**
Encode browser float samples as the native v2 mono 24 kHz PCM16 stream.
*/
function pcm16(source: Float32Array, sourceRate: number) {
  const count = Math.max(1, Math.floor((source.length * TARGET_RATE) / sourceRate));
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < count; i++) {
    const position = (i * sourceRate) / TARGET_RATE;
    const left = Math.min(source.length - 1, Math.floor(position));
    const right = Math.min(source.length - 1, left + 1);
    const sample = Math.max(-1, Math.min(1, source[left] + (source[right] - source[left]) * (position - left)));

    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true);
  }

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return { data: btoa(binary), sampleRate: TARGET_RATE, numChannels: 1, samplesPerChannel: count };
}

/**
Decode the observed native PCM16 output without leaking audio to logging.
*/
function decodePcm16(data: string) {
  const binary = atob(data);
  const samples = new Float32Array(binary.length / 2);

  for (let i = 0; i < samples.length; i++) {
    const word = (binary.codePointAt(i * 2) ?? 0) | ((binary.codePointAt(i * 2 + 1) ?? 0) << 8);

    samples[i] = (word & 0x80_00 ? word - 65_536 : word) / 32_768;
  }

  return samples;
}

async function command(body: unknown) {
  const response = await fetch(pocketUrl("/api/realtime"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: typeof body === "object" && body !== null && "action" in body && body.action === "stop",
    signal: AbortSignal.timeout(20_000),
  });
  const data = dataSchema.parse(await response.json());

  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Realtime connection failed.");
  }

  return data;
}

interface Resources {
  token?: string;
  context: AudioContext;
  stream: MediaStream;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  inputAnalyser: AnalyserNode;
  outputAnalyser: AnalyserNode;
  outputTime: number;
  abort: AbortController;
  sending: Promise<unknown>;
  queuedChunks: number;
  active: boolean;
  ready: boolean;
}

/**
Own one browser microphone/playback pipeline and release it on every exit path.
*/
export function useRealtime() {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const resources = useRef<Resources | null>(null);
  const pendingStream = useRef<MediaStream | null>(null);
  const pendingContext = useRef<AudioContext | null>(null);
  const nextId = useRef(0);
  const stopping = useRef(false);
  const generation = useRef(0);
  const starting = useRef(false);

  const stop = useCallback(async () => {
    generation.current++;
    starting.current = false;
    const current = resources.current;
    const waitingStream = pendingStream.current;
    const waitingContext = pendingContext.current;

    pendingStream.current = null;
    pendingContext.current = null;

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
        await command({ action: "stop", token });
      } catch {
        /*
        Local tracks are already stopped; server stream abort also stops native.
        */
      }
    }
  }, []);

  const receive = useCallback(
    (current: Resources, message: Record<string, unknown>) => {
      if (!current.active) {
        return;
      }

      const type = message.type;

      if (type === "active" || type === "started") {
        current.ready = true;
        setState("active");

        return;
      }

      if (type === "error" || type === "closed") {
        if (type === "error") {
          setError(typeof message.error === "string" ? message.error : "Realtime connection failed.");
        }

        void stop();

        return;
      }

      if (type === "audio") {
        const audio = outputAudioSchema.safeParse(message.audio);

        if (!audio.success || audio.data.sampleRate !== TARGET_RATE || audio.data.numChannels !== 1) {
          return;
        }

        const samples = decodePcm16(audio.data.data);
        const buffer = current.context.createBuffer(1, samples.length, TARGET_RATE);

        buffer.copyToChannel(samples, 0);
        const source = current.context.createBufferSource();

        source.buffer = buffer;
        source.connect(current.outputAnalyser);
        const at = Math.max(current.context.currentTime + 0.025, current.outputTime);

        source.start(at);
        current.outputTime = at + buffer.duration;
        source.addEventListener("ended", () => {
          source.disconnect();
        });

        return;
      }

      if (type !== "transcriptDelta" && type !== "transcriptDone") {
        return;
      }

      const role = message.role === "assistant" || message.role === "user" ? message.role : null;

      const text = message.text;

      if (!role || typeof text !== "string") {
        return;
      }

      setSegments((entries) => {
        const index = entries.findLastIndex((entry) => entry.role === role && !entry.done);

        if (index !== -1) {
          return entries.map((entry, at) =>
            at === index
              ? {
                  ...entry,
                  text: type === "transcriptDone" ? text : entry.text + text,
                  done: type === "transcriptDone",
                }
              : entry
          );
        }

        return [...entries, { id: ++nextId.current, role, text, done: type === "transcriptDone" }];
      });
    },
    [stop]
  );

  const listen = useCallback(
    async (current: Resources, token: string) => {
      let response: Response;

      try {
        response = await fetch(pocketUrl("/api/realtime/events"), {
          headers: { "X-Pocket-Realtime-Token": token },
          signal: current.abort.signal,
        });
      } catch {
        throw new Error("Realtime event stream failed.");
      }

      if (!response.ok || !response.body) {
        throw new Error("Realtime event stream failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let pending = "";

      while (current.active) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        pending += decoder.decode(value, { stream: true });
        let index: number;

        while ((index = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, index);

          pending = pending.slice(index + 1);

          if (line) {
            receive(current, dataSchema.parse(JSON.parse(line)));
          }
        }
      }

      if (current.active) {
        throw new Error("Realtime disconnected.");
      }
    },
    [receive]
  );

  const start = useCallback(async () => {
    if (state !== "idle" || resources.current || starting.current) {
      return;
    }

    starting.current = true;
    const attempt = ++generation.current;

    setError("");
    setState("starting");
    setSegments([]);
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

      context = new AudioContext();
      pendingContext.current = context;
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
      const current: Resources = {
        context,
        stream,
        source,
        processor,
        inputAnalyser,
        outputAnalyser,
        outputTime: 0,
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
          .then(() => (current.active ? command({ action: "audio", token: current.token, audio }) : undefined))
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
      const result = await command({ action: "start" });

      if (!current.active || generation.current !== attempt) {
        if (typeof result.token === "string") {
          void command({ action: "stop", token: result.token }).catch(() => {
            // The session was already stopped while start was pending.
          });
        }

        return;
      }

      if (typeof result.token !== "string") {
        throw new TypeError("Realtime did not return a session token.");
      }

      current.token = result.token;
      starting.current = false;
      void listen(current, result.token).catch((error_: unknown) => {
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
  }, [listen, state, stop]);

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
