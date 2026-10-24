import { dataSchema } from "./protocol";
import { pocketUrl } from "./pockets";
import { type VoiceSegment, voiceSegmentSchema } from "./voice-history";
import { HTTP_FORBIDDEN } from "./constants";

const CONTROL_TIMEOUT_MS = 40_000;

export interface VoiceResources {
  commandUrl: string;
  eventsUrl: string;
  token?: string;
  nativeSessionId?: string;
  context: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  remoteSource?: MediaStreamAudioSourceNode;
  inputAnalyser: AnalyserNode;
  outputAnalyser: AnalyserNode;
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  output: HTMLAudioElement;
  abort: AbortController;
  startingRequest?: Promise<Record<string, unknown>>;
  connectionTimer?: ReturnType<typeof setTimeout>;
  active: boolean;
}

/** Send lifecycle controls only. Media never uses HTTP commands.
@param body - Session negotiation or stop request.
@param url - Selected Pocket control endpoint.
@returns Validated control response.
*/
export async function realtimeCommand(body: unknown, url = pocketUrl("/api/realtime")) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: typeof body === "object" && body !== null && "action" in body && body.action === "stop",
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  const data = dataSchema.parse(await response.json());

  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Realtime connection failed.");
  }

  return data;
}

/** Receive saved transcripts and lifecycle notices independently of browser audio playback.
@param current - Browser connection receiving these events.
@param message - Validated server control event.
@param callbacks - UI history, warning and lifecycle handlers.
*/
export function receiveRealtime(
  current: VoiceResources,
  message: Record<string, unknown>,
  callbacks: { stop: () => void; error: (message: string) => void; transcript: (entry: VoiceSegment) => void }
) {
  if (!current.active) {
    return;
  }

  if (message.type === "error" || message.type === "warning") {
    callbacks.error(typeof message.error === "string" ? message.error : "Realtime connection failed.");
  }

  if (["error", "closed", "idle"].includes(String(message.type))) {
    callbacks.stop();
  }

  if (message.type !== "transcriptDone" && message.type !== "transcriptDelta") {
    return;
  }

  const segment = voiceSegmentSchema.safeParse({ ...message, done: message.type === "transcriptDone" });

  if (segment.success) {
    callbacks.transcript(segment.data);
  }
}

/** Stream lightweight history and status events; audio travels over the peer connection.
@param current - Connection whose abort signal owns this request.
@param token - Private server control token.
@param receive - Parsed history/status consumer.
*/
export async function listenRealtime(
  current: VoiceResources,
  token: string,
  receive: (message: Record<string, unknown>) => void
) {
  const response = await fetch(current.eventsUrl, {
    headers: { "X-Pocket-Realtime-Token": token },
    signal: current.abort.signal,
  });

  if (response.status === HTTP_FORBIDDEN) {
    const data = dataSchema.parse(await response.json());

    receive({ type: "error", error: data.error });

    return;
  }

  if (!response.ok || !response.body) {
    throw new Error("Realtime control stream failed.");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  let pending = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      if (current.active) {
        throw new Error("Realtime control stream disconnected.");
      }

      return;
    }

    pending += value;
    const lines = pending.split("\n");

    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        receive(dataSchema.parse(JSON.parse(line)));
      }
    }
  }
}

/** Close a negotiated call even if the user cancelled while setup was in flight.
@param current - Locally released connection whose negotiation may still finish.
*/
export async function stopRealtime(current: VoiceResources) {
  let started;

  try {
    started = await current.startingRequest;
  } catch {
    // Failed negotiation is cleaned up by the server and has no browser token.
    return;
  }

  const token = current.token ?? (typeof started?.token === "string" ? started.token : undefined);

  if (token) {
    await realtimeCommand({ action: "stop", token }, current.commandUrl);
  }
}
