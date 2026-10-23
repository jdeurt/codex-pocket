/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- Transport methods operate on the single owned provider socket. */
import { type Data, dataSchema, object, string } from "../lib/protocol";
import WebSocket, { type RawData } from "ws";
import { audioSchema } from "./realtime-schema";

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 128_000;
const MAX_EVENT_BYTES = 1_000_000;
const FINAL_TRANSCRIPT_MS = 3000;
const MIN_COMMIT_SAMPLES = 2400;
export const REALTIME_MODEL = "gpt-realtime-2.1";
export const REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];

/**
Request a response only after the speech item's final transcript is durable.
@param itemId - Provider identity of finalized user speech.
@returns Provider response request bound to this speech item.
*/
export function responseForSpeech(itemId: string) {
  return {
    type: "response.create",
    response: {
      instructions:
        `Respond to finalized speech item_id ${JSON.stringify(itemId)}. ` +
        "If main-agent work is needed, pass this exact item_id to handoff_to_pocket. Do not paraphrase the request.",
    },
  };
}

/**
Configure speech and one handoff tool; tool arguments identify saved speech rather than rewriting it.
*/
function configuration(voice: string) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["audio"],
      instructions:
        "You are Pocket's voice interface. Speak briefly. For work requiring the main agent or tools, call " +
        "handoff_to_pocket with the supplied finalized speech item_id. Never rewrite the user's request, " +
        "claim to have performed tool work, or call tools for an older speech item.",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription: { model: "gpt-4o-transcribe" },
          turn_detection: { type: "server_vad", create_response: false, interrupt_response: true },
        },
        output: { format: { type: "audio/pcm", rate: 24_000 }, voice },
      },
      tools: [
        {
          type: "function",
          name: "handoff_to_pocket",
          description: "Ask the main Pocket agent to act on this finalized speech, unchanged.",
          parameters: {
            type: "object",
            properties: { item_id: { type: "string" } },
            required: ["item_id"],
            additionalProperties: false,
          },
        },
      ],
    },
  };
}

/**
Decode ws binary variants before validating the JSON event boundary.
*/
function decode(raw: RawData) {
  const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw;
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;

  return dataSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/**
Own an authenticated server-side OpenAI WebSocket; never expose or log the credential or raw frames.
*/
export class OpenAIRealtime {
  private socket?: WebSocket;
  private ready = false;
  private stopped = false;
  private uncommittedSamples = 0;
  private pendingTranscripts = new Set<string>();
  private awaitingCommit = false;
  private inputSettled?: () => void;

  /**
  Bind the provider event consumer for this session.
  */
  constructor(private receive: (event: Data) => void) {}

  /**
  Track transcription completion independently of asynchronous transcript persistence.
  */
  private trackInput(event: Data) {
    const itemId = string(event.item_id);

    switch (event.type) {
      case "input_audio_buffer.committed": {
        this.uncommittedSamples = 0;
        this.awaitingCommit = false;
        this.pendingTranscripts.add(itemId);
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        this.pendingTranscripts.delete(itemId);
        break;
      }

      case "conversation.item.input_audio_transcription.failed": {
        this.receive({ type: "error", error: { message: "Speech transcription failed. No handoff was sent." } });
        break;
      }
      // No default
    }

    if (!this.awaitingCommit && this.pendingTranscripts.size === 0) {
      this.inputSettled?.();
    }
  }

  /**
  Complete provider configuration before allowing microphone input.
  */
  connect(key: string, voice: string, model = REALTIME_MODEL, endpoint = "wss://api.openai.com/v1/realtime") {
    const url = new URL(endpoint);

    url.searchParams.set("model", model);
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      maxPayload: MAX_EVENT_BYTES,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });

    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const message = "OpenAI Realtime did not confirm its configuration.";

        reject(new Error(message));
        this.receive({ type: "error", error: { message } });
        this.close();
      }, CONNECT_TIMEOUT_MS);
      const fail = (message: string) => {
        clearTimeout(timer);
        reject(new Error(message));

        if (this.stopped) {
          return;
        }

        this.receive({ type: "error", error: { message } });
        this.close();
      };

      socket.on("open", () => {
        socket.send(JSON.stringify(configuration(voice)));
      });
      socket.on("message", (raw) => {
        if (this.stopped) {
          return;
        }

        let event: Data;

        try {
          event = decode(raw);
        } catch {
          fail("OpenAI Realtime returned an invalid event.");

          return;
        }

        if (event.type === "session.updated") {
          this.ready = true;
          clearTimeout(timer);
          resolve();
        } else if (event.type === "error") {
          // Provider messages may echo a submitted value; return only its structured code.
          const code = string(object(event.error).code).replaceAll(/[^a-z_]/g, "");

          if (code === "input_audio_buffer_commit_empty" && this.awaitingCommit) {
            this.awaitingCommit = false;
            this.uncommittedSamples = 0;
            this.trackInput({});

            return;
          }

          fail(`OpenAI Realtime failed${code ? ` (${code})` : ""}. Check Settings and try again.`);

          return;
        }

        this.trackInput(event);
        this.receive(event);
      });
      socket.on("error", () => {
        fail("OpenAI Realtime connection failed. Check your API key in Settings.");
      });
      socket.on("close", () => {
        clearTimeout(timer);
        reject(new Error("OpenAI Realtime closed before it was ready."));
        this.ready = false;

        if (this.stopped) {
          return;
        }

        this.stopped = true;
        this.receive({ type: "closed" });
      });
    });
  }

  /**
  Commit captured speech on voice/text switching and bound the wait for its finalized transcript.
  */
  async finishInput() {
    if (this.uncommittedSamples >= MIN_COMMIT_SAMPLES) {
      this.awaitingCommit = true;
      this.send({ type: "input_audio_buffer.commit" });
    }

    if (!this.awaitingCommit && this.pendingTranscripts.size === 0) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        this.inputSettled = resolve;
        timer = setTimeout(() => {
          reject(new Error("Final speech transcription was not confirmed. Check your transcript before retrying."));
        }, FINAL_TRANSCRIPT_MS);
      });
    } finally {
      clearTimeout(timer);
      this.inputSettled = undefined;
    }
  }

  /**
  Bound outgoing frames before adding them to the provider socket's queue.
  */
  send(event: Data) {
    if (!this.ready || this.stopped || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime has stopped.");
    }

    const encoded = JSON.stringify(event);

    if (this.socket.bufferedAmount + Buffer.byteLength(encoded) > MAX_BUFFER_BYTES) {
      throw new Error("Audio connection is too slow.");
    }

    this.socket.send(encoded);
  }

  /**
  Accept only bounded mono PCM16 at 24 kHz and verify the decoded dimensions.
  */
  append(input: unknown) {
    const audio = audioSchema.parse(input);

    if (Buffer.from(audio.data, "base64").byteLength !== audio.samplesPerChannel * 2) {
      throw new Error("Invalid PCM16 audio length.");
    }

    this.send({ type: "input_audio_buffer.append", audio: audio.data });
    this.uncommittedSamples += audio.samplesPerChannel;
  }

  /**
  Invalidate this socket synchronously so stale media cannot enter a later session.
  */
  close() {
    this.stopped = true;
    this.ready = false;
    this.socket?.terminate();
  }
}
