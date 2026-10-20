import { type Thread, threadSchema } from "../../src/lib/protocol";
import Database from "better-sqlite3";
import { z } from "zod";

const recordSchema = z.object({ id: z.string(), value: z.string() });
const savedSchema = z.object({ thread: threadSchema, archived: z.boolean() });

/**
Store independent simulated native sessions without cross-process lost updates.
*/
export class CodexPersistence {
  private db: Database.Database;
  private previous = new Map<string, string>();

  /** Open the test-owned native-style state database.
  @param filename - Explicit isolated simulator path.
  */
  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  /** Reload unowned sessions while retaining live turn objects for this transport.
  @param threads - Transport's current session map.
  @param archived - Transport's archived identities.
  @param loaded - Sessions owned by this live transport.
  */
  read(threads: Map<string, Thread>, archived: Set<string>, loaded: Set<string>) {
    const rows = z.array(recordSchema).parse(this.db.prepare("SELECT * FROM threads").all());

    for (const row of rows) {
      const saved = savedSchema.parse(JSON.parse(row.value));

      if (loaded.has(row.id)) {
        continue;
      }

      threads.set(row.id, saved.thread);
      this.previous.set(row.id, row.value);

      if (saved.archived) {
        archived.add(row.id);
      } else {
        archived.delete(row.id);
      }
    }
  }

  /** Commit only locally changed sessions, leaving other live parents untouched.
  @param threads - Transport's current session map.
  @param archived - Transport's current archive flags.
  */
  write(threads: Map<string, Thread>, archived: Set<string>) {
    this.db
      .transaction(() => {
        for (const [id, thread] of threads) {
          const value = JSON.stringify({ thread, archived: archived.has(id) });

          if (value === this.previous.get(id)) {
            continue;
          }

          this.db.prepare("INSERT OR REPLACE INTO threads VALUES (?,?)").run(id, value);
          this.previous.set(id, value);
        }

        for (const id of this.previous.keys()) {
          if (threads.has(id)) {
            continue;
          }

          this.db.prepare("DELETE FROM threads WHERE id=?").run(id);
          this.previous.delete(id);
        }
      })
      .immediate();
  }
}
