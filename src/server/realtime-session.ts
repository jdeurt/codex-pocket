/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, unicorn/try-complexity, complexity -- Native session mutations are sequential and native notifications share one session handler. */
import { type RealtimeMessage, parseOutputAudio, settingsSchema, voiceListSchema } from "./realtime-schema";
import { type RpcEvent, string } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { requestRealtimeStop, waitForRealtimeClosed } from "./realtime-lifecycle";
import { type Bridge } from "./bridge-session";
import { type CodexRpc } from "./rpc";
import { RealtimeMediaLane } from "./realtime-media-lane";
import { createHash } from "node:crypto";
import { realtimeInfo } from "./realtime-settings-info";
import type { z } from "zod";

/**
Own one realtime session on the existing parent native connection.
*/
export class RealtimeSession extends EventTarget {
  private token?: string;
  private phase: "idle" | "connecting" | "active" | "stopping" | "uncertain" = "idle";
  private nativeSessionId?: string;
  private stoppingThreadId?: string;
  private closure?: { resolve: () => void };
  private settings?: z.infer<typeof settingsSchema>;
  private lastError?: string;
  private media: RealtimeMediaLane;
  private stoppingToken?: string;
  private stopTask?: Promise<void>;

  constructor(private owner: Bridge) {
    super();
    this.media = new RealtimeMediaLane(owner, () => ({
      token: this.token,
      nativeSessionId: this.nativeSessionId,
      phase: this.phase,
    }));
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

  private async finishStop() {
    this.token = undefined;
    this.phase = "stopping";
    this.stoppingThreadId = this.owner.snapshot.threadId;
    this.publish({ type: "closed" });
    const threadId = this.stoppingThreadId;
    const rpc: CodexRpc | undefined =
      this.owner.snapshot.connection === "connected" ? this.owner.agentReader() : undefined;
    const closed = new Promise<void>((resolve) => {
      this.closure = { resolve };
    });
    const deadline = waitForRealtimeClosed(closed);

    // The audio result is now unknown, but its 90s wait must not hold the serialized stop behind it.
    rpc?.abandonRealtime("thread/realtime/appendAudio");
    requestRealtimeStop(
      rpc,
      threadId,
      () => this.phase === "stopping" || this.phase === "uncertain",
      (error) => {
        if (this.status().type === "stopping") {
          this.lastError = error instanceof Error ? error.message : "Native realtime stop failed.";
        }
      }
    );

    try {
      await deadline;
    } catch (error) {
      if (this.status().type === "stopping") {
        this.phase = "uncertain";
        this.lastError = error instanceof Error ? error.message : "Native realtime closure was not confirmed.";
      }

      throw error;
    } finally {
      this.closure = undefined;
      rpc?.abandonRealtime("thread/realtime/stop");
      this.stoppingToken = undefined;
      this.stopTask = undefined;
    }
  }

  /**
  Read actual v2 voices and the effective configured model without making a static catalog.
  */
  async info() {
    await this.owner.ensureConnected();
    const id = this.threadId();
    const saved = await this.saved(id);

    return realtimeInfo(this.owner, saved, this.phase);
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
    return this.media.append(token, input);
  }

  /**
  Release the browser token immediately and bound native shutdown from this invocation.
  */
  stop(token: string) {
    if (token === this.stoppingToken && this.stopTask) {
      return this.stopTask;
    }

    if (!this.token || token !== this.token) {
      return Promise.resolve();
    }

    this.stoppingToken = token;
    const task = this.finishStop();

    this.stopTask = task;

    return task;
  }

  // Validate the stream owner on every subscription.
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

  // Clear a failed session after native or network loss.
  disconnect(message: string) {
    this.token = undefined;
    this.nativeSessionId = undefined;
    this.stoppingThreadId = undefined;
    this.phase = "idle";
    this.lastError = message;
    this.publish({ type: "error", error: message });
    this.closure?.resolve();
    this.closure = undefined;
    this.stoppingToken = undefined;
    this.stopTask = undefined;
  }
}
