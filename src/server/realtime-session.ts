import { REALTIME_VOICES } from "./openai-realtime";
import { readPocketSettings, updatePocketSettings } from "./pocket-settings";
import type { Bridge } from "./bridge-session";
import { OpenAIVoiceSession } from "./openai-voice-session";
import { BridgeVoiceOwner, voicePreferences } from "./bridge-voice-owner";
import { voiceWorkerResult } from "../state/voice-context";
import { settingsSchema } from "./realtime-schema";
import { type Turn } from "../lib/protocol";

/**
Select an explicitly enabled loopback provider fixture; production always uses OpenAI.
@returns Authorized loopback URL, or the production default.
*/
function fixtureEndpoint() {
  const endpoint = process.env.POCKET_REALTIME_TEST_URL;

  if (!endpoint || process.env.NODE_ENV === "production") {
    return;
  }

  const url = new URL(endpoint);

  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("The realtime test provider must use loopback WebSocket transport.");
  }

  return url.href;
}

/**
Bind independent OpenAI speech to the main session's durable, source-aware handoff path.
*/
export class RealtimeSession extends OpenAIVoiceSession {
  /** Start media controls only after the current native parent is connected.
  @param sdp - Browser offer.
  @returns Provider answer after negotiation.
  */
  private startConnected = async (sdp: string) => {
    await this.bridge.ensureConnected();

    if (this.bridge.snapshot.connection !== "connected") {
      throw new Error("Pocket is not connected.");
    }

    return super.start(sdp, fixtureEndpoint());
  };

  /**
  Retain Bridge serialization for lifecycle controls without routing audio through its native RPC.
  @param bridge - Main-agent runtime.
  */
  constructor(private bridge: Bridge) {
    super(new BridgeVoiceOwner(bridge));
  }

  /** Return verified main-agent findings as native Live commentary context.
  @param completed - Parent-scoped native turn supplied by the bridge.
  */
  completed(completed?: Turn) {
    const result = voiceWorkerResult(this.bridge.snapshot, completed);

    if (result) {
      for (const id of result.ids) {
        this.answer(id, result.text, result.status);
      }
    }
  }

  /**
  Return next-session preferences, live fragments, and saved conversation without credentials.
  @returns Public configuration and observed history.
  */
  async info() {
    await this.bridge.ensureConnected();
    const saved = await voicePreferences();
    const central = await readPocketSettings();

    return {
      ...saved,
      voices: REALTIME_VOICES,
      configuredModel: central.realtimeModel,
      phase: this.status().type,
      sessionId: this.identity(),
      live: this.liveCaptions(),
      effectiveFor: "next realtime session; an active session keeps its voice and model",
      modelCatalog: "OpenAI validates the selected realtime model when the next session starts.",
      history: await this.transcripts(),
    };
  }

  /**
  Flush observed fragments before text resumes, without making live speech wait for storage.
  */
  async prepareText() {
    if (this.status().type !== "idle") {
      throw new Error("Stop realtime before sending a typed message.");
    }

    await this.transcripts();
  }

  /**
  Update only the central settings fields; existing per-thread native voice files are no longer read.
  @param input - Untrusted settings mutation.
  @returns Confirmed public configuration.
  */
  async update(input: unknown) {
    const change = settingsSchema.parse(input);

    if (!change.voice && change.model === undefined) {
      throw new Error("Choose a voice or model.");
    }

    if (change.voice && !REALTIME_VOICES.includes(change.voice)) {
      throw new Error("That voice is unavailable in GPT-Live.");
    }

    await updatePocketSettings({ realtimeVoice: change.voice, realtimeModel: change.model });

    return this.info();
  }

  /**
  Start speech on an independent provider connection after the owning main session is ready.
  @param sdp - Browser offer.
  @returns Provider answer after negotiation.
  */
  override start(sdp: string) {
    return this.bridge.exclusive(this.startConnected, sdp);
  }
}
