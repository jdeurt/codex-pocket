import { object, string } from "../lib/protocol";
import { type Bridge } from "./bridge-session";
import { voiceListSchema } from "./realtime-schema";

/**
Read native realtime options for the selected Pocket and its saved next-session settings.
@param owner - Connected parent bridge.
@param saved - Saved settings for this parent thread.
@param phase - Current native realtime lifecycle phase.
@returns Effective voice, model, and actual native voice catalog.
*/
export async function realtimeInfo(owner: Bridge, saved: { voice?: string; model?: string | null }, phase: string) {
  const rpc = owner.agentReader();
  const [listed, config] = await Promise.all([
    rpc.request("thread/realtime/listVoices", {}),
    rpc.request("config/read", { includeLayers: false }),
  ]);
  const voices = voiceListSchema.parse(listed).voices;
  const effective = object(object(config).config);

  return {
    voice: saved.voice ?? voices.defaultV2,
    voices: voices.v2,
    model: saved.model ?? (string(effective.experimental_realtime_ws_model) || null),
    configuredModel: string(effective.experimental_realtime_ws_model) || null,
    phase,
    effectiveFor: "next realtime session; an active session keeps its voice and model",
    modelCatalog:
      "The runtime does not expose a realtime model catalog. An explicit model is verified when the next session starts.",
  };
}
