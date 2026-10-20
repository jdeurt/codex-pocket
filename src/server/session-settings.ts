import { readLocal, writeLocal } from "./local-state";
import { z } from "zod";

export const sessionSettingsSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => value.model !== undefined || value.effort !== undefined, "Supply model or effort.");
const savedSettingsSchema = z.object({ threadId: z.string(), settings: sessionSettingsSchema });

/**
Read only the configured parent's persisted model and effort override.
@param threadId - Exact native owner restored by the live connection.
@returns Saved settings for this owner, never another chat's settings.
*/
export async function savedSessionSettings(threadId: string) {
  const saved = savedSettingsSchema.nullable().parse(await readLocal("session-settings.json", null));

  return saved?.threadId === threadId ? saved.settings : undefined;
}

/**
Persist effective settings only after native acceptance and readback.
@param threadId - Exact owning native parent.
@param settings - Validated effective model and effort.
*/
export async function saveSessionSettings(threadId: string, settings: z.infer<typeof sessionSettingsSchema>) {
  await writeLocal("session-settings.json", { threadId, settings });
}
