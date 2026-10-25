import { t } from "try";
import { valueAfterCleanup } from "../lib/results";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { privateDatabase } from "../server/private-database";
import { taskDirectory } from "./archive";
import { assertLedgerTransition } from "./invariants";
import { initialLedger, ledgerSchema, type Ledger } from "./model";

const rowSchema = z.object({ payload: z.string() });

/**
Effect boundary for one parent's transactional ledger. Exact native records remain immutable source files.
*/
export class TaskRepository {
  private readonly db;

  /** Open private parent storage without consulting another parent's task namespace.
  @param parentId - Application-owned parent identity.
  */
  constructor(readonly parentId: string) {
    const directory = taskDirectory(parentId);

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = privateDatabase(
      path.join(directory, "ledger.sqlite"),
      `
      CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commits (revision INTEGER PRIMARY KEY, reason TEXT NOT NULL);
    `
    );
    this.db.prepare("INSERT OR IGNORE INTO checkpoint VALUES (1, ?)").run(JSON.stringify(initialLedger(parentId)));
  }

  /** Replace membership, decisions, correlations and cursor inside the caller's immediate transaction.
  @param next - Pure transition output, retaining its expected input revision.
  @param reason - Bounded audit description of the committed operation.
  @returns Committed checkpoint.
  */
  private replace(next: Ledger, reason: string): Ledger {
    const current = this.read();

    if (next.parentId !== this.parentId || next.revision !== current.revision) {
      throw new Error("Stale or cross-parent task commit; reconsider against the current revision.");
    }

    if (JSON.stringify(next) === JSON.stringify(current)) {
      return current;
    }

    const encoded = JSON.stringify({ ...next, revision: current.revision + 1 });
    const state = ledgerSchema.parse(JSON.parse(encoded));

    assertLedgerTransition(current, state);

    this.db.prepare("UPDATE checkpoint SET payload=? WHERE id=1").run(JSON.stringify(state));
    this.db.prepare("INSERT INTO commits VALUES (?, ?)").run(state.revision, reason);

    return state;
  }

  /** Execute a pure transition while holding the immediate transaction.
  @param reason - Audit description.
  @param transition - Pure state transformation with explicit bound inputs.
  @returns Committed state.
  */
  private apply(reason: string, transition: (state: Ledger) => Ledger) {
    return this.replace(transition(this.read()), reason);
  }

  /** Load the authoritative state, validating both schema and parent isolation.
  @returns Durable checkpoint.
  */
  read(): Ledger {
    const row = rowSchema.parse(this.db.prepare("SELECT payload FROM checkpoint WHERE id=1").get());
    const state = ledgerSchema.parse(JSON.parse(row.payload));

    if (state.parentId !== this.parentId) {
      throw new Error("Task ledger belongs to another parent.");
    }

    return state;
  }

  /** Atomically compare and commit a complete transition without holding a lock across model calls.
  @param next - Proposed checkpoint and expected revision.
  @param reason - Explanation of the operation.
  @returns Committed state, or a stale-revision error without partial writes.
  */
  commit(next: Ledger, reason: string) {
    return this.db.transaction(this.replace.bind(this)).immediate(next, reason);
  }

  /** Serialize deterministic ingestion and repairs across processes.
  @param reason - Audit description.
  @param transition - Pure transition, without filesystem or provider calls.
  @returns Durable next checkpoint.
  */
  update(reason: string, transition: (state: Ledger) => Ledger) {
    return this.db.transaction(this.apply.bind(this)).immediate(reason, transition);
  }

  /**
  Release the native database handle.
  */
  close() {
    this.db.close();
  }
}

/** Own a parent ledger handle for one deterministic transaction, including failure cleanup.
@param parentId - Authorized parent.
@param reason - Audit operation.
@param transition - Pure transition with all other inputs bound explicitly.
@returns Durable next state.
*/
export function updateTasks(parentId: string, reason: string, transition: (state: Ledger) => Ledger) {
  const repository = new TaskRepository(parentId);
  const result = t(repository.update.bind(repository), reason, transition);
  const closed = t(repository.close.bind(repository));

  return valueAfterCleanup(result, closed);
}
