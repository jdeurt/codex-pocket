import { REALTIME_VOICES } from "./openai-realtime";
import { type VoiceHandoff, type VoiceSegment } from "../lib/voice-history";

export interface VoiceSessionOwner {
  threadId: () => string;
  lastItemId?: () => string | null;
  context?: (history: VoiceSegment[]) => string;
  readKey: () => Promise<string | null>;
  preferences: () => Promise<{ voice: string; model: string }>;
  handoff: (input: VoiceHandoff) => Promise<{ status: string }>;
}

/**
Read provider configuration without allowing a storage error to echo private credential values.
@param owner - Settings readers supplied by the integration owner.
@returns Current key and public voice preferences.
*/
export async function readVoiceConfiguration(owner: VoiceSessionOwner) {
  let configuration;

  try {
    const [key, preferences] = await Promise.all([owner.readKey(), owner.preferences()]);

    configuration = { key, ...preferences };
  } catch {
    throw new Error("Could not load realtime configuration from Settings.");
  }

  if (!configuration.key) {
    throw new Error("Add an OpenAI API key in Settings to enable realtime voice.");
  }

  if (!REALTIME_VOICES.includes(configuration.voice)) {
    throw new Error("Choose a supported OpenAI realtime voice in Settings.");
  }

  return { ...configuration, key: configuration.key };
}
