import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { type PersistStorage, type StorageValue } from "zustand/middleware";
import { type ZodType, z } from "zod";
import path from "node:path";
import { t as attempt } from "try";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DATABASE_TIMEOUT_MS = 3000;
const rowSchema = z.object({ value: z.string() });

type StorageCommand<T> =
  { kind: "read" | "remove"; key: string } | { kind: "write"; key: string; value: StorageValue<T> };

/** Execute an explicit persistence command on an already owned database handle.
@param db - Handle owned by the runtime caller.
@param filename - Private host database location.
@param schema - Validator for durable data.
@param command - Read, write or removal request.
@returns Versioned data for a read, or null after a write/removal.
*/
function executeCommand<T>(db: Database.Database, filename: string, schema: ZodType<T>, command: StorageCommand<T>) {
  chmodSync(filename, FILE_MODE);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS zustand_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const envelope = z.object({ state: schema, version: z.number().optional() });

  switch (command.kind) {
    case "read": {
      const row = db.prepare("SELECT value FROM zustand_state WHERE key=?").get(command.key);

      return row ? envelope.parse(JSON.parse(rowSchema.parse(row).value)) : null;
    }

    case "write": {
      const saved = JSON.stringify(envelope.parse(command.value));

      db.prepare("INSERT OR REPLACE INTO zustand_state VALUES (?,?)").run(command.key, saved);
      break;
    }

    case "remove": {
      db.prepare("DELETE FROM zustand_state WHERE key=?").run(command.key);
      break;
    }
  }

  return null;
}

/** Own a database handle for exactly one synchronous command, including failure cleanup.
@param filename - Private host database location.
@param schema - Validator for durable data.
@param command - Explicit storage request.
@returns Versioned data for a read, or null after a mutation.
*/
function databaseCommand<T>(filename: string, schema: ZodType<T>, command: StorageCommand<T>) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: DIRECTORY_MODE });
  const db = new Database(filename, { timeout: DATABASE_TIMEOUT_MS });
  const outcome = attempt(executeCommand<T>, db, filename, schema, command);

  db.close();

  if (!outcome.ok) {
    throw outcome.error;
  }

  return outcome.value;
}

/**
Explicit SQLite effect boundary implementing Zustand's persistence protocol.
*/
class SqliteStorage<T> implements PersistStorage<T> {
  /** Read validated durable data.
  @param key - Conversation identity.
  @returns Existing versioned value or no saved state.
  */
  getItem = (key: string) => databaseCommand(this.filename, this.schema, { kind: "read", key });

  /** Atomically replace one conversation's durable state.
  @param key - Conversation identity.
  @param value - Versioned data to persist.
  */
  setItem = (key: string, value: StorageValue<T>) => {
    databaseCommand(this.filename, this.schema, { kind: "write", key, value });
  };

  /** Delete one conversation's durable state.
  @param key - Conversation identity.
  */
  removeItem = (key: string) => {
    databaseCommand(this.filename, this.schema, { kind: "remove", key });
  };

  /** Bind explicit database and validation dependencies without opening a handle.
  @param filename - Private host database location.
  @param schema - Validator for durable data.
  */
  constructor(
    private readonly filename: string,
    private readonly schema: ZodType<T>
  ) {}
}

/** Create a lazy SQLite runtime adapter without importing browser APIs.
@param filename - Private host database.
@param schema - Validator for the persisted subset.
@returns Explicit SQLite operations with per-command handle cleanup.
*/
export function sqliteStorage<T>(filename: string, schema: ZodType<T>): PersistStorage<T> {
  return new SqliteStorage(filename, schema);
}
