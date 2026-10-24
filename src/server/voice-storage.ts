import { type PersistStorage } from "zustand/middleware";
import { savedVoiceSchema, type SavedVoice } from "../state/saved-voice";
import { voiceHistorySchema } from "../lib/voice-history";
import { localDirectory, readLocal } from "./local-state";
import { sqliteStorage } from "./zustand-storage";
import path from "node:path";

/** Restore legacy JSON histories until the first successful SQLite write for the same thread.
@returns Versioned storage; existing JSON remains intact for rollback and failed migrations.
*/
export function voiceStorage(): PersistStorage<SavedVoice> {
  const storage = sqliteStorage(path.join(localDirectory(), "voice-history.sqlite"), savedVoiceSchema);

  return {
    ...storage,
    getItem: async (key) => {
      const saved = await storage.getItem(key);

      if (saved) {
        return saved;
      }

      const legacy = voiceHistorySchema.parse(await readLocal(`voice-history/${key}.json`, []));
      const segments = legacy.map((entry) =>
        entry.handoff === "sending" ? { ...entry, handoff: "unknown" as const } : entry
      );

      return { version: 1, state: { segments } };
    },
  };
}
