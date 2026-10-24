import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { t } from "try";
import { valueAfterCleanup } from "../lib/results";
import { migrateColumns } from "./sqlite-columns";

export const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_TIMEOUT_MS = 3000;

interface DatabaseOptions {
  timeout?: number;
  foreignKeys?: boolean;
  migration?: { table: string; column: string; sql: string };
}

/** Initialize an owned native handle using only host-authored schema and migration SQL.
@param db - Newly opened handle.
@param filename - Private database pathname.
@param schema - Existing application schema.
@param options - Native lock timeout, foreign-key policy and optional migration.
*/
function initializeDatabase(db: Database.Database, filename: string, schema: string, options: DatabaseOptions) {
  chmodSync(filename, PRIVATE_FILE_MODE);
  db.pragma("journal_mode = WAL");

  if (options.foreignKeys) {
    db.pragma("foreign_keys = ON");
  }

  db.exec(schema);

  if (!options.migration) {
    return;
  }

  const { table, column, sql } = options.migration;

  db.transaction(migrateColumns).immediate(db, table, column, sql);
}

/** Acquire private SQLite storage and release it if initialization fails.
@param filename - Path inside a directory already owned by the caller.
@param schema - Static table and index definitions.
@param options - Explicit native database policy.
@returns Initialized handle whose lifetime belongs to the caller.
*/
export function privateDatabase(filename: string, schema: string, options: DatabaseOptions = {}) {
  const db = new Database(filename, { timeout: options.timeout ?? DEFAULT_TIMEOUT_MS });
  const initialized = t(initializeDatabase, db, filename, schema, options);

  if (!initialized.ok) {
    valueAfterCleanup(initialized, t(db.close.bind(db)));
  }

  return db;
}
