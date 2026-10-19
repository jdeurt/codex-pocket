import { chmodSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";

const BUSY_TIMEOUT_MS = 1000;
const PRIVATE_FILE_MODE = 0o600;

export function delegationDatabase(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "delegations.sqlite");
  const db = new Database(filename, { timeout: BUSY_TIMEOUT_MS });
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
    CREATE TABLE IF NOT EXISTS delegation_requests (
      id TEXT PRIMARY KEY, childId TEXT NOT NULL REFERENCES side_pockets(id), parentId TEXT NOT NULL,
      nativeId TEXT NOT NULL, method TEXT NOT NULL, input TEXT NOT NULL,
      answer TEXT, status TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
  `);

  return db;
}
