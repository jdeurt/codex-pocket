import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { type PersistStorage } from "zustand/middleware";
import { type ZodType, z } from "zod";
import path from "node:path";
import { t as attempt } from "try";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DATABASE_TIMEOUT_MS = 3000;

/** Open a private SQLite adapter only for the duration of a storage operation.
@param filename - Host-owned database location; never supplied by a browser.
@param operation - Single synchronous database transaction or read.
@returns Storage result with its database handle already released.
*/
function withDatabase<T>(filename: string, operation: (db: Database.Database) => T) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: DIRECTORY_MODE });
  const db = new Database(filename, { timeout: DATABASE_TIMEOUT_MS });

  const outcome = attempt(() => {
    chmodSync(filename, FILE_MODE);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS zustand_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    return { value: operation(db) };
  });

  db.close();

  if (outcome.ok) {
    return outcome.value.value;
  }

  throw outcome.error;
}

/** Supply validated SQLite persistence to vanilla Zustand stores without importing browser APIs.
@param filename - Private host database.
@param schema - Validator for the persisted subset, excluding transient state and actions.
@returns Zustand persist adapter with atomic replacement per key.
*/
export function sqliteStorage<T>(filename: string, schema: ZodType<T>): PersistStorage<T> {
  const envelope = z.object({ state: schema, version: z.number().optional() });
  const row = z.object({ value: z.string() });

  return {
    getItem: (key) =>
      withDatabase(filename, (db) => {
        const result = db.prepare("SELECT value FROM zustand_state WHERE key=?").get(key);

        if (!result) {
          return null;
        }

        const saved = row.parse(result);

        return envelope.parse(JSON.parse(saved.value));
      }),
    setItem: (key, value) => {
      withDatabase(filename, (db) => {
        const saved = JSON.stringify(envelope.parse(value));

        db.prepare("INSERT OR REPLACE INTO zustand_state VALUES (?,?)").run(key, saved);
      });
    },
    removeItem: (key) => {
      withDatabase(filename, (db) => {
        db.prepare("DELETE FROM zustand_state WHERE key=?").run(key);
      });
    },
  };
}
