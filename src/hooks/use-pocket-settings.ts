"use client";
import { type PocketSettingsMutation, pocketSettingsSchema } from "@/lib/settings";
import { post } from "@/lib/client-api";
import { useAgentRead } from "./use-agents";

/** Subscribe to global public settings, including the main-chat tool visibility preference.
@returns Validated settings and recoverable read errors, without credentials.
*/
export function usePocketSettings() {
  return useAgentRead("/api/settings", pocketSettingsSchema);
}

/** Save supplied global settings and wake mounted readers after durable acceptance.
@param change - Preference or write-only credential fields to change.
@returns Validated public settings after the update.
*/
export async function savePocketSettings(change: PocketSettingsMutation) {
  const settings = pocketSettingsSchema.parse(await post("/api/settings", change));

  globalThis.dispatchEvent(new Event("online"));

  return settings;
}
