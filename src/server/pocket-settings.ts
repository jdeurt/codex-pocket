import { t as captureResult } from "try";
import { openaiApiKeySchema, pocketSettingsMutationSchema, type PocketSettingsMutation } from "../lib/settings";
import { readLocal, writeLocal } from "./local-state";
import { changedSettings, publicSettings, savedSettingsSchema } from "../state/pocket-settings";
import { SerialQueue } from "../runtime/serial-queue";

declare global {
  var pocketSettingsQueue: SerialQueue | undefined;
}

const operations = globalThis.pocketSettingsQueue ?? new SerialQueue();

if (!globalThis.pocketSettingsQueue) {
  Object.defineProperty(globalThis, "pocketSettingsQueue", { value: operations, configurable: true });
}

/** Read global preferences and credentials from Pocket's private host storage.
@returns Validated saved settings, using defaults only when the file is absent.
*/
async function readSavedSettings() {
  const loaded = await captureResult(readLocal, "settings.json", {});
  const parsed = loaded.ok ? savedSettingsSchema.safeParse(loaded.value) : null;

  // Never expose parse errors that may quote credential-bearing file contents.
  if (!parsed?.success) {
    throw new Error("Could not read Pocket settings.", { cause: loaded.ok ? parsed?.error : loaded.error });
  }

  return parsed.data;
}

/** Resolve an optional host credential without exposing it through public settings.
@returns The valid environment key, or null when no key is configured.
*/
function environmentKey() {
  return openaiApiKeySchema.safeParse(process.env.OPENAI_API_KEY).data ?? null;
}

/** Read the current global settings without returning credential values.
@returns Browser-safe preferences and effective credential availability.
*/
export async function readPocketSettings() {
  return publicSettings(await readSavedSettings(), !!environmentKey());
}

/** Resolve the current key when starting a server-side Pi or realtime session.
@returns The saved OpenAI key, the host environment fallback, or null.
*/
export async function readOpenAIApiKey(): Promise<string | null> {
  const saved = await readSavedSettings();

  return saved.openaiApiKey ?? environmentKey();
}

/** Persist a queued mutation against the latest durable settings.
@param change - Validated fields supplied by this operation.
@returns Public preferences after the write succeeds.
*/
async function commitSettings(change: PocketSettingsMutation) {
  const saved = changedSettings(await readSavedSettings(), change);

  await writeLocal("settings.json", saved);

  return publicSettings(saved, !!environmentKey());
}

/** Apply supplied fields in order while preserving each caller's own write failure.
@param input - Partial settings mutation; null removes the saved credential.
@returns Public settings after atomic private persistence completes.
*/
export function updatePocketSettings(input: PocketSettingsMutation) {
  return operations.run(commitSettings, pocketSettingsMutationSchema.parse(input));
}
