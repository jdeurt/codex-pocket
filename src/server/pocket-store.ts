import { requireRemovablePocket } from "../state/pockets";
import { mkdirSync } from "node:fs";
import type Database from "better-sqlite3";
import { privateDatabase } from "./private-database";
import { localDirectory } from "./local-state";
import path from "node:path";
import { pocketSchema } from "../lib/pockets";
import { z } from "zod";

const DIRECTORY_MODE = 0o700;
const DATABASE_TIMEOUT_MS = 3000;
const savedSchema = pocketSchema.extend({ deleted: z.number() });

const stores = new Map<string, PocketStore>();

/**
Persist named main Pockets separately from delegated Side Pockets.
*/
export class PocketStore {
  private db: Database.Database;
  readonly remove;

  /** Open private durable metadata and preserve deletions across future startup.
  @param directory - Private Pocket state directory.
  */
  constructor(directory: string) {
    const filename = path.join(directory, "pockets.sqlite");

    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
    this.db = privateDatabase(
      filename,
      `CREATE TABLE IF NOT EXISTS pockets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, threadId TEXT,
      state TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Ready',
      deleted INTEGER NOT NULL DEFAULT 0
    )`,
      { timeout: DATABASE_TIMEOUT_MS }
    );
    const remove = this.db.transaction(this.removeEntry.bind(this));

    this.remove = remove.immediate.bind(remove);
  }

  /** Hide an idle Pocket while retaining its native history and durable receipts.
  @param id - Identity whose runtime has been checked for pending work.
  */
  private removeEntry(id: string) {
    const entry = this.get(id);

    requireRemovablePocket(this.list(), entry);

    this.db.prepare("UPDATE pockets SET deleted=1 WHERE id=?").run(id);
  }

  /**
  Mark interrupted creation receipts as incomplete without repeating native dispatch.
  */
  recover() {
    this.db.prepare("UPDATE pockets SET state='failed',status='Setup incomplete' WHERE state='creating'").run();
  }

  /** Import the configured conversation once without resurrecting a deleted entry.
  @param threadId - Original configured native conversation.
  */
  seed(threadId: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO pockets (id,name,threadId,state) VALUES ('main','Pocket',?,'ready')")
      .run(threadId);
  }

  /** Read surviving entries in creation order.
  @returns Saved named conversations, including incomplete creation receipts.
  */
  list() {
    return z.array(savedSchema).parse(this.db.prepare("SELECT * FROM pockets WHERE deleted=0 ORDER BY rowid").all());
  }

  /** Require a saved, non-deleted identity before any native operation.
  @param id - Opaque catalog identity, never an arbitrary native thread.
  @returns The durable entry.
  */
  get(id: string) {
    const value = this.db.prepare("SELECT * FROM pockets WHERE id=? AND deleted=0").get(id);

    if (!value) {
      throw new Error("This Pocket is no longer available. Choose another Pocket.");
    }

    return savedSchema.parse(value);
  }

  /** Reserve creation before native dispatch so retries cannot create duplicate threads.
  @param id - Client-generated idempotency key.
  @param name - Validated display name.
  @returns Whether this call owns the first creation attempt.
  */
  reserve(id: string, name: string) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO pockets (id,name,state,status) VALUES (?,?,'creating','Creating…')")
        .run(id, name).changes > 0
    );
  }

  /** Save native identity immediately after native creation acknowledges.
  @param id - Reserved catalog identity.
  @param threadId - Native acknowledged thread identity.
  */
  attach(id: string, threadId: string) {
    this.db.prepare("UPDATE pockets SET threadId=? WHERE id=?").run(threadId, id);
  }

  /** Record creation outcome without automatically retrying uncertain native work.
  @param id - Reserved catalog identity.
  @param isReady - Whether native naming and persistence completed.
  */
  finish(id: string, isReady: boolean) {
    this.db
      .prepare("UPDATE pockets SET state=?,status=? WHERE id=?")
      .run(isReady ? "ready" : "failed", isReady ? "Ready" : "Setup incomplete", id);
  }

  /** Rename a saved conversation without changing its native or draft identity.
  @param id - Saved catalog identity.
  @param name - Validated replacement name.
  */
  rename(id: string, name: string) {
    this.get(id);
    this.db.prepare("UPDATE pockets SET name=? WHERE id=? AND deleted=0").run(name, id);
  }

  /** Keep previews readable after server restarts while deriving them from visible content.
  @param id - Saved Pocket owning the snapshot.
  @param preview - Latest visible activity or conversation excerpt.
  @param status - User-facing state derived from the live bridge.
  */
  preview(id: string, preview: string, status: string) {
    this.db.prepare("UPDATE pockets SET preview=?,status=? WHERE id=? AND deleted=0").run(preview, status, id);
  }
}

/** Reuse the metadata connection belonging to this configured state directory.
@returns The durable named-Pocket catalog.
*/
export function pocketStore() {
  const directory = localDirectory();
  const existing = stores.get(directory);
  const store = existing ?? new PocketStore(directory);

  stores.set(directory, store);

  return store;
}
