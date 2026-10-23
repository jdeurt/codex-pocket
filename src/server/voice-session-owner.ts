import { type VoiceHandoff } from "../lib/voice-history";

export interface VoiceSessionOwner {
  threadId: () => string;
  readKey: () => Promise<string | null>;
  preferences: () => Promise<{ voice: string; model: string }>;
  handoff: (input: VoiceHandoff) => Promise<{ status: "queued" | "sent" | "unknown" | "sending" }>;
}

/**
Read provider configuration without allowing a storage error to echo private credential values.
@param owner - Settings readers supplied by the integration owner.
@returns Current key and public voice preferences.
*/
export async function readVoiceConfiguration(owner: VoiceSessionOwner) {
  try {
    const [key, preferences] = await Promise.all([owner.readKey(), owner.preferences()]);

    return { key, ...preferences };
  } catch {
    throw new Error("Could not load realtime configuration from Settings.");
  }
}
