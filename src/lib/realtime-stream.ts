/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers, @typescript-eslint/no-deprecated -- Browser PCM and event boundaries follow native realtime v2. */
import { dataSchema } from "./protocol";
import { pocketUrl } from "./pockets";
import { schedulePcm16 } from "./realtime-audio";
import { z } from "zod";
import { type VoiceSegment, voiceSegmentSchema } from "./voice-history";

export interface VoiceResources {
  commandUrl: string;
  eventsUrl: string;
  token?: string;
  nativeSessionId?: string;
  context: AudioContext;
  stream: MediaStream;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  inputAnalyser: AnalyserNode;
  outputAnalyser: AnalyserNode;
  outputTime: number;
  playback?: { itemId: string; start: number; samples: number };
  outputSources: Set<AudioBufferSourceNode>;
  abort: AbortController;
  sending: Promise<unknown>;
  startingRequest?: Promise<Record<string, unknown>>;
  inputParts: string[];
  inputSamples: number;
  pendingSamples: number;
  inputTimer?: ReturnType<typeof setTimeout>;
  inputError?: string;
  draining: boolean;
  active: boolean;
  ready: boolean;
}

const outputAudioSchema = z.object({ data: z.string(), sampleRate: z.number(), numChannels: z.number() });

export async function realtimeCommand(body: unknown, url = pocketUrl("/api/realtime")) {
  const response = await fetch(url, {
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

const INPUT_BATCH_SAMPLES = 6000;
const MAX_PENDING_INPUT_SAMPLES = 48_000;
const STOP_DRAIN_MS = 1500;

async function dispatchInput(
  current: VoiceResources,
  audio: { data: string; sampleRate: number; numChannels: number; samplesPerChannel: number }
) {
  if ((current.active || current.draining) && !current.inputError) {
    await realtimeCommand({ action: "audio", token: current.token, audio }, current.commandUrl);
  }
}

export function flushInput(current: VoiceResources, fail: (error: unknown) => void) {
  if (current.inputTimer) {
    clearTimeout(current.inputTimer);
    current.inputTimer = undefined;
  }

  if (!current.inputSamples || !current.token) {
    return;
  }

  const audio = {
    data: btoa(current.inputParts.join("")),
    sampleRate: 24_000,
    numChannels: 1,
    samplesPerChannel: current.inputSamples,
  };

  current.inputParts = [];
  current.inputSamples = 0;
  const previous = current.sending;

  current.sending = (async () => {
    try {
      await previous;

      await dispatchInput(current, audio);
    } catch (error) {
      current.inputError = error instanceof Error ? error.message : "Audio connection failed.";
      fail(error);
    } finally {
      current.pendingSamples -= audio.samplesPerChannel;
    }
  })();
}

export async function drainInput(current: VoiceResources) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      current.sending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Audio delivery could not finish before stopping."));
        }, STOP_DRAIN_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  if (current.inputError) {
    throw new Error(current.inputError);
  }
}

export function queueInput(current: VoiceResources, data: string, samples: number, fail: (error: unknown) => void) {
  current.pendingSamples += samples;

  if (current.pendingSamples > MAX_PENDING_INPUT_SAMPLES) {
    fail(new Error("Audio connection is too slow."));

    return;
  }

  current.inputParts.push(atob(data));
  current.inputSamples += samples;

  if (current.inputSamples >= INPUT_BATCH_SAMPLES) {
    flushInput(current, fail);
  } else {
    current.inputTimer ??= setTimeout(() => {
      flushInput(current, fail);
    }, 250);
  }
}

function receiveHandoff(
  current: VoiceResources,
  message: Record<string, unknown>,
  receive: (id: string, status: unknown, handoffId?: string) => void
) {
  if (typeof message.itemId === "string" && current.nativeSessionId) {
    receive(
      `realtime:${current.nativeSessionId}:${message.itemId}:user`,
      message.status,
      typeof message.handoffId === "string" ? message.handoffId : undefined
    );
  }
}

function playOutput(current: VoiceResources, data: string, itemId: unknown) {
  const samples = atob(data).length / 2;
  const end = schedulePcm16(current.context, current.outputAnalyser, current.outputSources, current.outputTime, data);

  if (typeof itemId === "string") {
    if (current.playback?.itemId !== itemId) {
      current.playback = { itemId: itemId, start: end - samples / 24_000, samples: 0 };
    }

    current.playback.samples += samples;
  }

  current.outputTime = end;
}

async function truncatePlayback(
  current: VoiceResources,
  callbacks: { error: (message: string) => void; stop: () => void }
) {
  const playback = current.playback;

  current.playback = undefined;

  if (!playback || !current.token) {
    return;
  }

  const seconds = Math.max(0, Math.min(current.context.currentTime - playback.start, playback.samples / 24_000));

  try {
    await realtimeCommand(
      { action: "truncate", token: current.token, itemId: playback.itemId, audioEndMs: Math.floor(seconds * 1000) },
      current.commandUrl
    );
  } catch {
    if (current.active) {
      callbacks.error("Interrupted playback could not be synchronized. Start voice again to continue.");
      callbacks.stop();
    }
  }
}

export function receiveRealtime(
  current: VoiceResources,
  message: Record<string, unknown>,
  callbacks: {
    active: () => void;
    stop: () => void;
    error: (message: string) => void;
    transcript: (entry: VoiceSegment) => void;
    handoff: (id: string, status: unknown, handoffId?: string) => void;
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
      playOutput(current, audio.data.data, message.itemId);
    } catch (error) {
      callbacks.error(error instanceof Error ? error.message : "Audio playback failed.");
      callbacks.stop();
    }

    return;
  }

  if (type === "handoff") {
    receiveHandoff(current, message, callbacks.handoff);

    return;
  }

  if (type === "interrupted") {
    void truncatePlayback(current, callbacks);
    current.outputTime = current.context.currentTime;

    for (const source of current.outputSources) {
      source.stop();
      source.disconnect();
    }

    current.outputSources.clear();

    return;
  }

  if (type !== "transcriptDone") {
    return;
  }

  const segment = voiceSegmentSchema.safeParse({ ...message, done: true });

  if (segment.success) {
    callbacks.transcript(segment.data);
  }
}

export async function listenRealtime(
  current: VoiceResources,
  token: string,
  receive: (message: Record<string, unknown>) => void
) {
  let response: Response;

  try {
    response = await fetch(current.eventsUrl, {
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
