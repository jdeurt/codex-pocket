import { readLocal, writeLocal } from "./local-state";
import { z } from "zod";
import { createHash } from "node:crypto";

export const sessionSettingsSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => value.model !== undefined || value.effort !== undefined, "Supply model or effort.");
const savedSettingsSchema = z.object({ threadId: z.string(), settings: sessionSettingsSchema });

/** Namespace settings so concurrently active named parents cannot overwrite each other.
@param threadId - Exact owning parent identity.
@returns Private relative settings filename.
*/
function settingsFile(threadId: string) {
  return `session-settings/${createHash("sha256").update(threadId).digest("hex")}.json`;
}

/**
Read only the configured parent's persisted model and effort override.
@param threadId - Exact native owner restored by the live connection.
@returns Saved settings for this owner, never another chat's settings.
*/
export async function savedSessionSettings(threadId: string) {
  const own = await readLocal(settingsFile(threadId), null);
  const saved = savedSettingsSchema.nullable().parse(own ?? (await readLocal("session-settings.json", null)));

  return saved?.threadId === threadId ? saved.settings : undefined;
}

/**
Persist effective settings only after native acceptance and readback.
@param threadId - Exact owning native parent.
@param settings - Validated effective model and effort.
*/
export async function saveSessionSettings(threadId: string, settings: z.infer<typeof sessionSettingsSchema>) {
  await writeLocal(settingsFile(threadId), { threadId, settings });
}
