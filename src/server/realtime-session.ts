/* eslint-disable jdeurt/const-on-top, @typescript-eslint/no-magic-numbers, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, unicorn/try-complexity -- Native session mutations are sequential; audio bounds match the observed protocol. */
import { type RpcEvent, object, string } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { type Bridge } from "./bridge-session";
import { createHash } from "node:crypto";
import { z } from "zod";

const audioSchema = z
  .object({
    data: z
      .string()
      .min(1)
      .max(48_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    sampleRate: z.literal(24_000),
    numChannels: z.literal(1),
    samplesPerChannel: z.number().int().positive().max(12_000),
  })
  .strict();
const settingsSchema = z
  .object({ voice: z.string().min(1).optional(), model: z.string().trim().min(1).max(120).nullable().optional() })
  .strict();
const voicesSchema = z.object({ v2: z.array(z.string()), defaultV2: z.string() }).loose();
const voiceListSchema = z.object({ voices: voicesSchema });

type Settings = z.infer<typeof settingsSchema>;
export interface RealtimeMessage {
  type: string;
  role?: string;
  text?: string;
  audio?: z.infer<typeof audioSchema>;
  error?: string;
}

/**
Own one realtime session on the existing parent native connection.
*/
export class RealtimeSession extends EventTarget {
  private token?: string;
  private phase: "idle" | "connecting" | "active" = "idle";
  private settings?: Settings;
  private lastError?: string;

  constructor(private owner: Bridge) {
    super();
  }

  private threadId() {
    const id = this.owner.snapshot.threadId;

    if (!id || this.owner.snapshot.connection !== "connected") {
      throw new Error("Pocket is not connected.");
    }

    return id;
  }

  private filename(id: string) {
    return `realtime/${createHash("sha256").update(id).digest("hex")}.json`;
  }

  private async saved(id: string) {
    this.settings ??= settingsSchema.parse(await readLocal(this.filename(id), {}));

    return this.settings;
  }

  private publish(message: RealtimeMessage) {
    this.dispatchEvent(new CustomEvent("message", { detail: message }));
  }

  /**
  Read actual v2 voices and the effective configured model without making a static catalog.
  */
  async info() {
    await this.owner.ensureConnected();
    const id = this.threadId();
    const rpc = this.owner.agentReader();
    const [listed, config] = await Promise.all([
      rpc.request("thread/realtime/listVoices", {}),
      rpc.request("config/read", { includeLayers: false }),
    ]);
    const voices = voiceListSchema.parse(listed).voices;
    const effective = object(object(config).config);
    const saved = await this.saved(id);

    return {
      voice: saved.voice ?? voices.defaultV2,
      voices: voices.v2,
      model: saved.model ?? (string(effective.experimental_realtime_ws_model) || null),
      configuredModel: string(effective.experimental_realtime_ws_model) || null,
      phase: this.phase,
      effectiveFor: "next realtime session; an active session keeps its voice and model",
      modelCatalog:
        "The runtime does not expose a realtime model catalog. An explicit model is verified when the next session starts.",
    };
  }

  /**
  Save settings only for this selected main Pocket and validate voices against the native list.
  */
  update(input: unknown) {
    return this.owner.exclusive(async () => {
      await this.owner.ensureConnected();
      const id = this.threadId();
      const change = settingsSchema.parse(input);

      if (!change.voice && change.model === undefined) {
        throw new Error("Choose a voice or model.");
      }

      if (change.voice) {
        const available = voiceListSchema.parse(
          await this.owner.agentReader().request("thread/realtime/listVoices", {})
        ).voices.v2;

        if (!available.includes(change.voice)) {
          throw new Error("That voice is unavailable in realtime v2.");
        }
      }

      this.settings = {
        ...(await this.saved(id)),
        ...(change.voice && { voice: change.voice }),
        ...(change.model !== undefined && { model: change.model }),
      };
      await writeLocal(this.filename(id), this.settings);

      return this.info();
    });
  }

  /**
  Begin v2 audio output; the token binds all subsequent audio and events to this session.
  */
  start() {
    return this.owner.exclusive(async () => {
      await this.owner.ensureConnected();

      if (this.token) {
        throw new Error("Realtime is already active for this Pocket.");
      }

      if (this.owner.snapshot.activeTurnId || this.owner.snapshot.queue.length > 0) {
        throw new Error("Wait for the current message to finish before starting realtime.");
      }

      const id = this.threadId();
      const saved = await this.saved(id);
      const token = crypto.randomUUID();

      this.token = token;
      this.phase = "connecting";
      this.lastError = undefined;

      try {
        await this.owner.agentReader().request("thread/realtime/start", {
          threadId: id,
          outputModality: "audio",
          transport: { type: "websocket" },
          version: "v2",
          ...(saved.voice && { voice: saved.voice }),
          ...(saved.model && { model: saved.model }),
        });
      } catch (error) {
        this.fail(error instanceof Error ? error.message : "Realtime could not start.");
        throw error;
      }

      return { token, phase: this.phase };
    });
  }

  /**
  Require the exact current token before touching native audio.
  */
  append(token: string, input: unknown) {
    return this.owner.exclusive(async () => {
      if (!this.token || token !== this.token || this.phase !== "active") {
        throw new Error("Realtime has stopped.");
      }

      const audio = audioSchema.parse(input);

      if (Buffer.from(audio.data, "base64").byteLength !== audio.samplesPerChannel * 2) {
        throw new Error("Invalid PCM16 audio length.");
      }

      await this.owner.agentReader().request("thread/realtime/appendAudio", { threadId: this.threadId(), audio });
    });
  }

  /**
  Release the browser token immediately, then stop native audio on the serialized bridge.
  */
  stop(token: string) {
    if (!this.token || token !== this.token) {
      return Promise.resolve();
    }

    this.token = undefined;
    this.phase = "idle";
    this.publish({ type: "closed" });

    return this.owner.exclusive(async () => {
      if (this.owner.snapshot.connection === "connected") {
        await this.owner.agentReader().request("thread/realtime/stop", { threadId: this.threadId() });
      }
    });
  }

  /**
  Validate the stream owner on every subscription.
  */
  owns(token: string) {
    return !!this.token && token === this.token;
  }

  status() {
    return { type: this.phase, error: this.lastError };
  }

  /**
  Handle only the selected parent's realtime notifications; never put raw audio in snapshots or logs.
  */
  event(event: RpcEvent) {
    if (
      !event.method.startsWith("thread/realtime/") ||
      !this.token ||
      event.params.threadId !== this.owner.snapshot.threadId
    ) {
      return;
    }

    const suffix = event.method.slice("thread/realtime/".length);

    switch (suffix) {
      case "started": {
        this.phase = "active";
        this.publish({ type: "started" });

        break;
      }

      case "outputAudio/delta": {
        const audio = object(event.params.audio);

        if (audio.sampleRate === 24_000 && audio.numChannels === 1 && typeof audio.data === "string") {
          const validated = audioSchema.safeParse({
            data: audio.data,
            sampleRate: 24_000,
            numChannels: 1,
            samplesPerChannel: Buffer.from(audio.data, "base64").byteLength / 2,
          });

          if (validated.success) {
            this.publish({ type: "audio", audio: validated.data });
          }
        }

        break;
      }

      case "transcript/delta":
      case "transcript/done": {
        this.publish({
          type: suffix === "transcript/done" ? "transcriptDone" : "transcriptDelta",
          role: string(event.params.role),
          text: string(event.params.text ?? event.params.delta),
        });

        break;
      }

      case "error": {
        this.fail(string(event.params.message) || "Realtime connection failed.");

        break;
      }

      case "closed": {
        this.token = undefined;
        this.phase = "idle";
        this.publish({ type: "closed" });

        break;
      }
      // No default
    }
  }

  /**
  Clear a failed session after native or network loss.
  */
  fail(message: string) {
    const shouldStop = this.phase === "active" && this.owner.snapshot.connection === "connected";
    const id = this.owner.snapshot.threadId;

    this.token = undefined;
    this.phase = "idle";
    this.lastError = message;
    this.publish({ type: "error", error: message });

    if (shouldStop && id) {
      void this.owner
        .exclusive(() => this.owner.agentReader().request("thread/realtime/stop", { threadId: id }))
        .catch(() => {
          // Native failure may already have closed the session.
        });
    }
  }
}
