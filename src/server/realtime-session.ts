/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- Realtime controls share the selected Bridge and central settings owner. */
import { REALTIME_MODEL, REALTIME_VOICES } from "./openai-realtime";
import { readOpenAIApiKey, readPocketSettings, updatePocketSettings } from "./pocket-settings";
import type { Bridge } from "./bridge-session";
import { OpenAIVoiceSession } from "./openai-voice-session";
import { settingsSchema } from "./realtime-schema";
import { visibleSnapshot } from "./visible-snapshot";
import { hasMessageText } from "../lib/turn-messages";

/**
Select an explicitly enabled loopback provider fixture; production always uses OpenAI.
*/
function fixtureEndpoint() {
  const endpoint = process.env.POCKET_REALTIME_TEST_URL;

  if (!endpoint || process.env.NODE_ENV === "production") {
    return;
  }

  const url = new URL(endpoint);

  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") {
    throw new Error("The realtime test provider must use loopback WebSocket transport.");
  }

  return url.href;
}

/**
Read public preferences fresh when each provider session starts.
*/
async function preferences() {
  const saved = await readPocketSettings();

  return { voice: saved.realtimeVoice ?? "marin", model: saved.realtimeModel ?? REALTIME_MODEL };
}

/**
Bind independent OpenAI speech to the main session's durable, source-aware handoff path.
*/
export class RealtimeSession extends OpenAIVoiceSession {
  /**
  Retain Bridge serialization for lifecycle controls without routing audio through its native RPC.
  */
  constructor(private bridge: Bridge) {
    super({
      threadId: () => {
        if (!bridge.snapshot.threadId) {
          throw new Error("Pocket is not connected.");
        }

        return bridge.snapshot.threadId;
      },
      lastItemId: () =>
        visibleSnapshot(bridge.snapshot)
          .turns.flatMap((turn) => turn.items)
          .findLast(hasMessageText)?.id ?? null,
      readKey: readOpenAIApiKey,
      preferences,
      handoff: (input) => bridge.handoff(input),
    });
  }

  /**
  Return central next-session preferences and finalized conversation history without credentials.
  */
  async info() {
    await this.bridge.ensureConnected();
    const saved = await preferences();
    const central = await readPocketSettings();

    return {
      ...saved,
      voices: REALTIME_VOICES,
      configuredModel: central.realtimeModel,
      phase: this.status().type,
      effectiveFor: "next realtime session; an active session keeps its voice and model",
      modelCatalog: "OpenAI validates the selected realtime model when the next session starts.",
      history: await this.transcripts(),
    };
  }

  /**
  Update only the central settings fields; existing per-thread native voice files are no longer read.
  */
  async update(input: unknown) {
    const change = settingsSchema.parse(input);

    if (!change.voice && change.model === undefined) {
      throw new Error("Choose a voice or model.");
    }

    if (change.voice && !REALTIME_VOICES.includes(change.voice)) {
      throw new Error("That voice is unavailable in OpenAI Realtime.");
    }

    await updatePocketSettings({ realtimeVoice: change.voice, realtimeModel: change.model });

    return this.info();
  }

  /**
  Start speech on an independent provider connection after the owning main session is ready.
  */
  override start() {
    return this.bridge.exclusive(async () => {
      await this.bridge.ensureConnected();

      if (this.bridge.snapshot.connection !== "connected") {
        throw new Error("Pocket is not connected.");
      }

      return super.start(fixtureEndpoint());
    });
  }
}
