import { openaiApiKeySchema, pocketSettingsMutationSchema, type PocketSettingsMutation } from "../lib/settings";
import { readLocal, writeLocal } from "./local-state";
import { z } from "zod";

const savedSettingsSchema = z
  .object({
    showToolCalls: z.boolean().default(false),
    openaiApiKey: openaiApiKeySchema.nullable().default(null),
  })
  .strict();

type SavedSettings = z.infer<typeof savedSettingsSchema>;

declare global {
  var codexPocketSettings: { serial: Promise<unknown> } | undefined;
}

const operations = globalThis.codexPocketSettings ?? { serial: Promise.resolve() };

if (!globalThis.codexPocketSettings) {
  Object.defineProperty(globalThis, "codexPocketSettings", { value: operations, configurable: true });
}

/** Read global preferences and credentials from Pocket's private host storage.
@returns Validated saved settings, using defaults only when the file is absent.
*/
async function readSavedSettings() {
  try {
    return savedSettingsSchema.parse(await readLocal("settings.json", {}));
  } catch {
    // JSON parse failures can quote the credential-bearing file contents.
    throw new Error("Could not read Pocket settings.");
  }
}

/** Resolve an optional host credential without exposing it through public settings.
@returns The valid environment key, or null when no key is configured.
*/
function environmentKey() {
  return openaiApiKeySchema.safeParse(process.env.OPENAI_API_KEY).data ?? null;
}

/** Project only preferences and credential availability for browser consumers.
@param saved - Validated host settings containing the private saved credential.
@returns Public settings with the effective credential source and no secret values.
*/
function publicSettings(saved: SavedSettings) {
  let openaiApiKeySource: "saved" | "environment" | null = null;

  if (saved.openaiApiKey) {
    openaiApiKeySource = "saved";
  } else if (environmentKey()) {
    openaiApiKeySource = "environment";
  }

  return {
    showToolCalls: saved.showToolCalls,
    openaiApiKeyConfigured: openaiApiKeySource !== null,
    openaiApiKeySource,
  };
}

/** Read the current global settings without returning credential values.
@returns Browser-safe preferences and effective credential availability.
*/
export async function readPocketSettings() {
  return publicSettings(await readSavedSettings());
}

/** Resolve the current key when starting a server-side Pi or realtime session.
@returns The saved OpenAI key, the host environment fallback, or null.
*/
export async function readOpenAIApiKey(): Promise<string | null> {
  const saved = await readSavedSettings();

  return saved.openaiApiKey ?? environmentKey();
}

/** Apply only supplied fields, preserving concurrent updates to other settings.
@param input - Partial settings mutation; null removes the saved credential.
@returns Public settings after atomic private persistence completes.
*/
export function updatePocketSettings(input: PocketSettingsMutation) {
  const change = pocketSettingsMutationSchema.parse(input);
  const previous = operations.serial;

  async function commit() {
    try {
      await previous;
    } catch {
      // Later settings changes can recover after a failed write.
    }

    const saved = await readSavedSettings();

    if (change.showToolCalls !== undefined) {
      saved.showToolCalls = change.showToolCalls;
    }

    if (change.openaiApiKey !== undefined) {
      saved.openaiApiKey = change.openaiApiKey;
    }

    await writeLocal("settings.json", saved);

    return publicSettings(saved);
  }

  const result = commit();

  operations.serial = result;

  return result;
}
