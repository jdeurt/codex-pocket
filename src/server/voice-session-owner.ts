import { type VoiceHandoff } from "../lib/voice-history";

export interface VoiceSessionOwner {
  threadId: () => string;
  readKey: () => Promise<string | null>;
  preferences: () => Promise<{ voice: string; model: string }>;
  handoff: (input: VoiceHandoff) => Promise<{ status: "queued" | "sent" | "unknown" | "sending" }>;
}
