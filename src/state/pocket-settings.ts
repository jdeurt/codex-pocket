import { openaiApiKeySchema, realtimeSettingSchema, type PocketSettingsMutation } from "../lib/settings";
import { z } from "zod";
import { migratedRealtimeModel } from "./realtime-configuration";

export const savedSettingsSchema = z
  .object({
    showToolCalls: z.boolean().default(false),
    realtimeVoice: realtimeSettingSchema.nullable().default(null),
    realtimeModel: realtimeSettingSchema.nullable().default(null).transform(migratedRealtimeModel),
    openaiApiKey: openaiApiKeySchema.nullable().default(null),
  })
  .strict();

export type SavedSettings = z.infer<typeof savedSettingsSchema>;

/** Project only preferences and credential availability for browser consumers.
@param saved - Validated host settings containing the private saved credential.
@param hasEnvironmentKey - Whether the runtime validated an environment credential.
@returns Public settings with the effective credential source and no secret values.
*/
export function publicSettings(saved: SavedSettings, hasEnvironmentKey: boolean) {
  let openaiApiKeySource: "saved" | "environment" | null = null;

  if (saved.openaiApiKey) {
    openaiApiKeySource = "saved";
  } else if (hasEnvironmentKey) {
    openaiApiKeySource = "environment";
  }

  return {
    showToolCalls: saved.showToolCalls,
    realtimeVoice: saved.realtimeVoice,
    realtimeModel: saved.realtimeModel,
    openaiApiKeyConfigured: openaiApiKeySource !== null,
    openaiApiKeySource,
  };
}

/** Merge only supplied preference fields without changing the saved record.
@param saved - Validated durable preferences.
@param change - Validated partial mutation.
@returns New complete settings with unspecified fields retained.
*/
export function changedSettings(saved: SavedSettings, change: PocketSettingsMutation): SavedSettings {
  return {
    showToolCalls: change.showToolCalls ?? saved.showToolCalls,
    openaiApiKey: change.openaiApiKey === undefined ? saved.openaiApiKey : change.openaiApiKey,
    realtimeVoice: change.realtimeVoice === undefined ? saved.realtimeVoice : change.realtimeVoice,
    realtimeModel: migratedRealtimeModel(
      change.realtimeModel === undefined ? saved.realtimeModel : change.realtimeModel
    ),
  };
}
