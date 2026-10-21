/* eslint-disable jdeurt/const-on-top, jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, @typescript-eslint/no-deprecated -- Browser PCM and event boundaries follow native realtime v2. */
import { dataSchema } from "./protocol";
import { pocketUrl } from "./pockets";
import { schedulePcm16 } from "./realtime-audio";
import { z } from "zod";

export interface VoiceSegment {
  id: number;
  role: "user" | "assistant";
  text: string;
  done: boolean;
  nativeSessionId?: string;
}

export interface VoiceResources {
  token?: string;
  nativeSessionId?: string;
  context: AudioContext;
  stream: MediaStream;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  inputAnalyser: AnalyserNode;
  outputAnalyser: AnalyserNode;
  outputTime: number;
  outputSources: Set<AudioBufferSourceNode>;
  abort: AbortController;
  sending: Promise<unknown>;
  queuedChunks: number;
  active: boolean;
  ready: boolean;
}

const outputAudioSchema = z.object({ data: z.string(), sampleRate: z.number(), numChannels: z.number() });

export async function realtimeCommand(body: unknown) {
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

export function receiveRealtime(
  current: VoiceResources,
  message: Record<string, unknown>,
  callbacks: {
    active: () => void;
    stop: () => void;
    error: (message: string) => void;
    transcript: (role: "user" | "assistant", text: string, isDone: boolean, sessionId?: string) => void;
  }
) {
  if (!current.active) {
    return;
  }

  const type = message.type;

  if (type === "active" || type === "started") {
    current.ready = true;
    callbacks.active();

    return;
  }

  if (type === "error" || type === "closed") {
    if (type === "error") {
      callbacks.error(typeof message.error === "string" ? message.error : "Realtime connection failed.");
    }

    callbacks.stop();

    return;
  }

  if (type === "audio") {
    const audio = outputAudioSchema.safeParse(message.audio);

    if (!audio.success || audio.data.sampleRate !== 24_000 || audio.data.numChannels !== 1) {
      return;
    }

    try {
      current.outputTime = schedulePcm16(
        current.context,
        current.outputAnalyser,
        current.outputSources,
        current.outputTime,
        audio.data.data
      );
    } catch (error) {
      callbacks.error(error instanceof Error ? error.message : "Audio playback failed.");
      callbacks.stop();
    }

    return;
  }

  if (type !== "transcriptDelta" && type !== "transcriptDone") {
    return;
  }

  const role = message.role === "assistant" || message.role === "user" ? message.role : null;

  if (role && typeof message.text === "string") {
    callbacks.transcript(role, message.text, type === "transcriptDone", current.nativeSessionId);
  }
}

export async function listenRealtime(
  current: VoiceResources,
  token: string,
  receive: (message: Record<string, unknown>) => void
) {
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
        receive(dataSchema.parse(JSON.parse(line)));
      }
    }
  }

  if (current.active) {
    throw new Error("Realtime disconnected.");
  }
}
