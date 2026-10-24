import { type PersistStorage } from "zustand/middleware";
import { restoredVoiceSegment, savedVoiceSchema, type SavedVoice } from "../state/saved-voice";
import { voiceHistorySchema } from "../lib/voice-history";
import { localDirectory, readLocal } from "./local-state";
import { sqliteStorage } from "./zustand-storage";
import path from "node:path";

/** Read the durable ledger, falling back to legacy JSON until the first SQLite write.
@param storage - Explicit SQLite runtime adapter.
@param key - Thread-scoped persistence identity.
@returns Versioned captions with interrupted legacy handoffs marked uncertain.
*/
async function readVoice(storage: PersistStorage<SavedVoice>, key: string) {
  const saved = await storage.getItem(key);

  if (saved) {
    return saved;
  }

  const legacy = voiceHistorySchema.parse(await readLocal(`voice-history/${key}.json`, []));

  return { version: 1, state: { segments: Array.from(legacy, restoredVoiceSegment) } };
}

/** Create explicit persistence operations while keeping legacy files intact for rollback.
@returns Lazy versioned storage for one host's caption ledger.
*/
export function voiceStorage(): PersistStorage<SavedVoice> {
  const storage = sqliteStorage(path.join(localDirectory(), "voice-history.sqlite"), savedVoiceSchema);

  return { getItem: readVoice.bind(undefined, storage), setItem: storage.setItem, removeItem: storage.removeItem };
}
