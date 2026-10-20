import { chmodSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { commandStatusSchema } from "./delegation-data";
import path from "node:path";
import { z } from "zod";

const BUSY_TIMEOUT_MS = 1000;
const PRIVATE_FILE_MODE = 0o600;

/**
Initialize the native private SQLite file only after its parent directory exists.
@param filename - Absolute private database path inside the created state directory.
@returns Native SQLite handle with the existing tables, indexes and safety pragmas.
*/
function openDelegationDatabase(filename: string) {
  const db = new Database(filename, { timeout: BUSY_TIMEOUT_MS });
  const columns = z.array(z.object({ name: z.string() }));

  chmodSync(filename, PRIVATE_FILE_MODE);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegation_parents (id TEXT PRIMARY KEY, context TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS side_pockets (
      id TEXT PRIMARY KEY, parentId TEXT NOT NULL, title TEXT NOT NULL, harness TEXT NOT NULL,
      cwd TEXT NOT NULL, sessionId TEXT, model TEXT, effort TEXT, policy TEXT NOT NULL,
      status TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      createKey TEXT NOT NULL, fingerprint TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(parentId, createKey)
    );
    CREATE INDEX IF NOT EXISTS side_pockets_parent ON side_pockets(parentId, createdAt);
    CREATE TABLE IF NOT EXISTS delegation_commands (
      id TEXT PRIMARY KEY, childId TEXT NOT NULL REFERENCES side_pockets(id),
      parentId TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      result TEXT, createdAt INTEGER NOT NULL, UNIQUE(childId, key)
    );
    CREATE TABLE IF NOT EXISTS delegation_mail (
      id TEXT PRIMARY KEY, childId TEXT NOT NULL REFERENCES side_pockets(id), parentId TEXT NOT NULL,
      sourceId TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      delivery TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(childId, sourceId)
    );
    CREATE TABLE IF NOT EXISTS delegate_summaries (
      messageId TEXT NOT NULL REFERENCES delegation_mail(id), digest TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL, owner INTEGER NOT NULL,
      PRIMARY KEY(messageId,digest)
    );
    CREATE TABLE IF NOT EXISTS delegation_requests (
      id TEXT PRIMARY KEY, childId TEXT NOT NULL REFERENCES side_pockets(id), parentId TEXT NOT NULL,
      nativeId TEXT NOT NULL, method TEXT NOT NULL, input TEXT NOT NULL,
      answer TEXT, status TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS delegation_command_recency ON delegation_commands(childId,createdAt DESC);
    CREATE INDEX IF NOT EXISTS delegation_request_status ON delegation_requests(childId,status);
  `);

  // Existing assignments retain their explicit queue semantics across the schema upgrade.
  db.transaction(() => {
    if (columns.parse(db.pragma("table_info(delegation_commands)")).every((column) => column.name !== "mode")) {
      db.exec(`ALTER TABLE delegation_commands ADD COLUMN mode TEXT NOT NULL DEFAULT 'queue';
        ALTER TABLE delegation_commands ADD COLUMN targetId TEXT;
        ALTER TABLE delegation_commands ADD COLUMN turnId TEXT;
        ALTER TABLE delegation_commands ADD COLUMN supersedes TEXT NOT NULL DEFAULT '[]';`);
    }
  }).immediate();

  return db;
}

/**
Open the private delegation database and establish its existing tables and indexes.
@param directory - Private state directory whose database and permissions are initialized.
@returns Native SQLite handle with WAL, foreign keys and bounded busy waiting.
*/
export function delegationDatabase(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  return openDelegationDatabase(path.join(directory, "delegations.sqlite"));
}

/**
Read the newest command status for one parent-owned child.
@param db - Existing native delegation database.
@param parentId - Parent scope required by the query.
@param childId - Child whose latest command is requested.
@returns Validated latest command status, or undefined when no command exists.
*/
export function lastCommandStatus(db: Database.Database, parentId: string, childId: string) {
  const row = z
    .object({ status: commandStatusSchema })
    .optional()
    .parse(
      db
        .prepare(
          "SELECT status FROM delegation_commands WHERE parentId=? AND childId=? AND targetId IS NULL ORDER BY createdAt DESC,rowid DESC LIMIT 1"
        )
        .get(parentId, childId)
    );

  return row?.status;
}
