import { type Bridge } from "./bridge-session";
import { type VoiceSessionOwner } from "./voice-session-owner";
import { type VoiceSegment } from "../lib/voice-history";
import { lastVisibleMessage, realtimeContext } from "../state/voice-context";
import { readOpenAIApiKey, readPocketSettings } from "./pocket-settings";
import { REALTIME_MODEL } from "./openai-realtime";

/** Load next-session preferences at the settings effect boundary.
@returns Current voice and model selections with documented defaults.
*/
export async function voicePreferences() {
  const saved = await readPocketSettings();

  return { voice: saved.realtimeVoice ?? "marin", model: saved.realtimeModel ?? REALTIME_MODEL };
}

/**
Explicit bridge adapter read by the independent realtime session.
*/
export class BridgeVoiceOwner implements VoiceSessionOwner {
  readonly readKey = readOpenAIApiKey;
  readonly preferences = voicePreferences;
  readonly handoff;

  /** Read the currently connected canonical parent identity.
  @returns Connected parent identity.
  */
  threadId = () => {
    const id = this.bridge.snapshot.threadId;

    if (!id) {
      throw new Error("Pocket is not connected.");
    }

    return id;
  };

  /** Project the current canonical anchor through the pure visibility policy.
  @returns Latest visible message identity.
  */
  lastItemId = () => lastVisibleMessage(this.bridge.snapshot);

  /** Project current conversation and explicit saved voice history for a new call.
  @param history - Saved captions.
  @returns Pure startup context.
  */
  context = (history: VoiceSegment[]) => realtimeContext(this.bridge.snapshot, history);

  /** Retain the actual main-agent worker and its evolving canonical state.
  @param bridge - Explicit parent runtime.
  */
  constructor(private readonly bridge: Bridge) {
    this.handoff = bridge.handoff.bind(bridge);
  }
}
