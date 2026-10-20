import { type DelegationCommand, delegationCommandSchema, pocket, storedPocketSchema } from "./delegation-data";
import type Database from "better-sqlite3";
import { type DelegationNotifications } from "./delegation-notifications";
import { type DelegationStore } from "./delegations";
import { commandText } from "./delegation-input";
import { z } from "zod";

export const MAX_CONCURRENT_CHILDREN = 8;

/**
Own durable child commands and preserve the global eight-slot native execution cap.
*/
export class DelegationQueue {
  /**
Bind the native command database and its concrete child and notification owners.
@param db - Private native delegation database shared by immediate transactions.
@param store - Child and parent persistence owner used for policy and lifecycle state.
@param notifications - Committed-change hints that wake the existing worker.
*/
  constructor(
    private db: Database.Database,
    private store: DelegationStore,
    private notifications: DelegationNotifications
  ) {}

  /**
Insert a validated new command only after retry and child-state guards succeed.
@param parentId - Recorded parent scope.
@param childId - Managed child accepting the command.
@param key - Validated stable command retry identity.
@param text - Validated exact command body.
@returns Validated newly persisted queued command.
*/
  private insertCommand(parentId: string, childId: string, key: string, text: string) {
    const id = crypto.randomUUID();

    this.db
      .prepare("INSERT INTO delegation_commands VALUES (?,?,?,?,?,'queued',NULL,?)")
      .run(id, childId, parentId, key, text, Date.now());
    this.notifications.changed();

    return delegationCommandSchema.parse(this.db.prepare("SELECT * FROM delegation_commands WHERE id=?").get(id));
  }

  /**
Claim the oldest queued command while the caller holds the immediate capacity transaction.
@param parentId - Recorded parent scope.
@param childId - Idle managed child already checked against the global running count.
@returns Claimed command, or undefined when no queued command remains.
*/
  private claimNext(parentId: string, childId: string) {
    const command = this.list(parentId, childId).find((entry) => entry.status === "queued");

    if (!command) {
      return;
    }

    this.db.prepare("UPDATE delegation_commands SET status='running' WHERE id=?").run(command.id);
    this.db
      .prepare("UPDATE side_pockets SET status='running',policy=?,updatedAt=? WHERE parentId=? AND id=?")
      .run(JSON.stringify(this.store.parent(parentId).policy), Date.now(), parentId, childId);

    return command;
  }

  /**
Release a completed command's child only when no persisted close request owns its state.
@param command - Persisted command whose terminal status has already been written.
@param status - Terminal or uncertain command outcome.
*/
  private finishChild(command: DelegationCommand, status: DelegationCommand["status"]) {
    const child = this.store.get(command.parentId, command.childId);

    if (!["closing", "closed"].includes(child.status)) {
      this.store.setStatus(command.parentId, command.childId, status === "unknown" ? "unknown" : "idle");
    }
  }

  /**
Persist a scoped follow-up once, retaining retries before closed-child rejection.
@param parentId - Recorded parent scope.
@param childId - Managed child accepting the follow-up.
@param key - Stable retry identity reused for the same body.
@param body - Exact follow-up body parsed by the shared command schema.
@returns Existing or newly queued native command.
*/
  send(parentId: string, childId: string, key: string, body: string) {
    const text = commandText(key, body);

    return this.db
      .transaction(() => {
        const child = this.store.get(parentId, childId);
        const existing = delegationCommandSchema
          .optional()
          .parse(this.db.prepare("SELECT * FROM delegation_commands WHERE childId=? AND key=?").get(childId, key));

        if (existing) {
          if (existing.body !== text) {
            throw new Error("This message key already belongs to different text.");
          }

          return existing;
        }

        if (["closing", "closed", "unknown"].includes(child.status)) {
          throw new Error(
            "Resume this Side Pocket before sending more work. Inspect unknown outcomes before continuing."
          );
        }

        return this.insertCommand(parentId, childId, key, text);
      })
      .immediate();
  }

  /**
Read the recorded command history for one parent-owned child.
@param parentId - Recorded parent scope.
@param childId - Managed child whose commands are requested.
@returns Validated native commands in durable creation order.
*/
  list(parentId: string, childId: string) {
    return z
      .array(delegationCommandSchema)
      .parse(
        this.db
          .prepare("SELECT * FROM delegation_commands WHERE parentId=? AND childId=? ORDER BY createdAt,rowid")
          .all(parentId, childId)
      );
  }

  /**
Atomically enforce child readiness and global capacity before claiming its oldest queued command.
@param parentId - Recorded parent scope.
@param childId - Managed child selected by the event-driven worker.
@returns Claimed native command, or undefined while no eligible capacity or work exists.
*/
  claim(parentId: string, childId: string) {
    return this.db
      .transaction(() => {
        const child = this.store.get(parentId, childId);
        const { count } = z
          .object({ count: z.number() })
          .parse(this.db.prepare("SELECT count(*) AS count FROM delegation_commands WHERE status='running'").get());

        if (child.status !== "idle" || count >= MAX_CONCURRENT_CHILDREN) {
          return;
        }

        return this.claimNext(parentId, childId);
      })
      .immediate();
  }

  /**
Read idle children in oldest-command order for the scoped worker's dispatch pass.
@param parentId - Configured parent whose queued work may dispatch.
@returns Normalized idle child records ordered by their oldest queued assignments.
*/
  queuedChildren(parentId: string) {
    const rows = z.array(storedPocketSchema).parse(
      this.db
        .prepare(
          `SELECT p.* FROM delegation_commands c JOIN side_pockets p ON p.id=c.childId
      WHERE c.parentId=? AND c.status='queued' AND p.status='idle'
      ORDER BY c.createdAt,c.rowid`
        )
        .all(parentId)
    );

    return rows.map((row) => pocket(row));
  }

  /**
Persist a command outcome before applying its guarded child lifecycle transition.
@param command - Persisted command that has settled or become uncertain.
@param status - Recorded command outcome.
@param result - Exact serialized native result or recovery diagnostic.
*/
  finish(command: DelegationCommand, status: DelegationCommand["status"], result: string) {
    this.db.prepare("UPDATE delegation_commands SET status=?,result=? WHERE id=?").run(status, result, command.id);
    this.finishChild(command, status);
  }

  /**
Atomically persist a command outcome and its optional parent report.
@param command - Persisted command that owns the result.
@param status - Recorded command outcome.
@param result - Exact serialized native result or recovery diagnostic.
@param report - Optional source-deduplicated parent report for the same command.
*/
  recordResult(
    command: DelegationCommand,
    status: DelegationCommand["status"],
    result: string,
    report?: { sourceId: string; kind: string; payload: unknown }
  ) {
    this.db.transaction(() => {
      this.finish(command, status, result);

      if (report) {
        this.store.mail.record(command.parentId, command.childId, report.sourceId, report.kind, report.payload);
      }
    })();
  }
}
