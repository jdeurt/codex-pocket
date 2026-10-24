"use client";
import { pocketSettingsSchema } from "@/lib/settings";
import { useAgentRead } from "./use-agents";

/** Subscribe to global public settings, including the main-chat tool visibility preference.
@returns Validated settings and recoverable read errors, without credentials.
*/
export function usePocketSettings() {
  return useAgentRead("/api/settings", pocketSettingsSchema);
}
