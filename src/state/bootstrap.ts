import { type Snapshot } from "../lib/protocol";
import { type VoiceSegment } from "../lib/voice-history";

export interface ClientBootstrap {
  pocketId: string;
  snapshot: Snapshot;
  captions: VoiceSegment[];
  resources: Record<string, unknown>;
}
