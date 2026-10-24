import { t } from "try";
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
  const [credential, preferred] = await Promise.all([t(owner.readKey.bind(owner)), t(owner.preferences.bind(owner))]);

  if (!credential.ok || !preferred.ok) {
    throw new Error("Could not load realtime configuration from Settings.", {
      cause: new AggregateError([credential.error, preferred.error], "Realtime settings reads failed."),
    });
  }

  const key = credential.value;
  const preferences = preferred.value;
  const configuration = { key, ...preferences };

  if (!configuration.key) {
    throw new Error("Add an OpenAI API key in Settings to enable realtime voice.");
  }

  if (!REALTIME_VOICES.includes(configuration.voice)) {
    throw new Error("Choose a supported OpenAI realtime voice in Settings.");
  }

  return { ...configuration, key: configuration.key };
}
