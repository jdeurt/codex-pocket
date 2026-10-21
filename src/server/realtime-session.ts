/* eslint-disable jdeurt/const-on-top, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, unicorn/try-complexity, complexity -- Native session mutations are sequential and native notifications share one session handler. */
import { type RpcEvent, object, string } from "../lib/protocol";
import { audioSchema, parseOutputAudio, settingsSchema, voiceListSchema } from "./realtime-schema";
import { readLocal, writeLocal } from "./local-state";
import { type Bridge } from "./bridge-session";
import { createHash } from "node:crypto";
import { waitForRealtimeClosed } from "./realtime-lifecycle";
import type { z } from "zod";

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
  private phase: "idle" | "connecting" | "active" | "stopping" | "uncertain" = "idle";
  private nativeSessionId?: string;
  private stoppingThreadId?: string;
  private closure?: { resolve: () => void };
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

      if (this.phase !== "idle") {
        throw new Error(
          this.phase === "uncertain"
            ? "Native realtime closure was not confirmed. Reconnect Pocket before starting again."
            : "Realtime is already active or stopping for this Pocket."
        );
      }

      if (this.owner.snapshot.activeTurnId || this.owner.snapshot.queue.length > 0) {
        throw new Error("Wait for the current message to finish before starting realtime.");
      }

      const id = this.threadId();
      const saved = await this.saved(id);
      const token = crypto.randomUUID();
      const nativeSessionId = crypto.randomUUID();

      this.token = token;
      this.nativeSessionId = nativeSessionId;
      this.phase = "connecting";
      this.lastError = undefined;

      try {
        await this.owner.agentReader().request("thread/realtime/start", {
          threadId: id,
          outputModality: "audio",
          transport: { type: "websocket" },
          version: "v2",
          realtimeSessionId: nativeSessionId,
          ...(saved.voice && { voice: saved.voice }),
          ...(saved.model && { model: saved.model }),
        });
      } catch (error) {
        this.token = undefined;
        this.nativeSessionId = undefined;
        this.phase = "idle";
        this.lastError = error instanceof Error ? error.message : "Realtime could not start.";
        this.publish({ type: "error", error: this.lastError });
        throw error;
      }

      return { token, nativeSessionId, phase: this.phase };
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
    this.phase = "stopping";
    this.stoppingThreadId = this.owner.snapshot.threadId;
    this.publish({ type: "closed" });

    return this.owner.exclusive(async () => {
      if (this.phase !== "stopping" || this.owner.snapshot.connection !== "connected") {
        return;
      }

      const threadId = this.threadId();
      const closed = new Promise<void>((resolve) => {
        this.closure = { resolve };
      });

      // Stop acknowledgment only confirms receipt. The native closed notification is the lifecycle barrier.
      void this.owner
        .agentReader()
        .request("thread/realtime/stop", { threadId })
        .catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : "Native realtime stop failed.";
        });

      try {
        await waitForRealtimeClosed(closed);
      } catch (error) {
        if (this.status().type === "stopping") {
          this.phase = "uncertain";
          this.lastError = error instanceof Error ? error.message : "Native realtime closure was not confirmed.";
        }

        throw error;
      } finally {
        this.closure = undefined;
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
      this.phase === "idle" ||
      (event.method !== "thread/realtime/closed" && this.phase === "uncertain") ||
      event.params.threadId !==
        (this.phase === "stopping" || this.phase === "uncertain" ? this.stoppingThreadId : this.owner.snapshot.threadId)
    ) {
      return;
    }

    const suffix = event.method.slice("thread/realtime/".length);

    if (suffix !== "closed" && suffix !== "error" && this.phase === "stopping") {
      return;
    }

    switch (suffix) {
      case "started": {
        const id = string(event.params.realtimeSessionId);

        if (this.phase !== "connecting" || (id && id !== this.nativeSessionId)) {
          break;
        }

        this.phase = "active";
        this.publish({ type: "started" });

        break;
      }

      case "outputAudio/delta": {
        const audio = parseOutputAudio(event.params.audio);

        if (audio) {
          this.publish({ type: "audio", audio });
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
        const message = string(event.params.message) || "Realtime connection failed.";

        if (this.phase === "stopping") {
          this.lastError = message;
          break;
        }

        this.lastError = message;
        this.publish({ type: "error", error: message });

        if (this.token) {
          void this.stop(this.token).catch(() => {
            // The bounded stop leaves an explicit uncertain state if native closure never arrives.
          });
        }

        break;
      }

      case "closed": {
        this.token = undefined;
        this.nativeSessionId = undefined;
        this.stoppingThreadId = undefined;
        this.phase = "idle";
        this.publish({ type: "closed" });
        this.closure?.resolve();

        break;
      }
      // No default
    }
  }

  /**
  Clear a failed session after native or network loss.
  */
  disconnect(message: string) {
    this.token = undefined;
    this.nativeSessionId = undefined;
    this.stoppingThreadId = undefined;
    this.phase = "idle";
    this.lastError = message;
    this.publish({ type: "error", error: message });
    this.closure?.resolve();
    this.closure = undefined;
  }
}
