import { z } from "zod";

export const OPENAI_API_KEY_LIMIT = 4096;
export const openaiApiKeySchema = z.string().trim().min(1).max(OPENAI_API_KEY_LIMIT).regex(/^\S+$/);
export const REALTIME_SETTING_LIMIT = 120;
export const realtimeSettingSchema = z
  .string()
  .trim()
  .min(1)
  .max(REALTIME_SETTING_LIMIT)
  .regex(/^[\w.-]+$/);

export const pocketSettingsSchema = z
  .object({
    showToolCalls: z.boolean(),
    realtimeVoice: realtimeSettingSchema.nullable(),
    realtimeModel: realtimeSettingSchema.nullable(),
    openaiApiKeyConfigured: z.boolean(),
    openaiApiKeySource: z.enum(["saved", "environment"]).nullable(),
  })
  .strict();

export const pocketSettingsMutationSchema = z
  .object({
    showToolCalls: z.boolean().optional(),
    realtimeVoice: realtimeSettingSchema.nullable().optional(),
    realtimeModel: realtimeSettingSchema.nullable().optional(),
    openaiApiKey: openaiApiKeySchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.showToolCalls !== undefined ||
      value.openaiApiKey !== undefined ||
      value.realtimeVoice !== undefined ||
      value.realtimeModel !== undefined,
    "Supply a setting to update."
  );

export type PocketSettings = z.infer<typeof pocketSettingsSchema>;
export type PocketSettingsMutation = z.infer<typeof pocketSettingsMutationSchema>;
