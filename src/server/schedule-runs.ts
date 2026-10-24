import { type Schedule, type ScheduledRun, storedRun } from "./schedule-db";
import type Database from "better-sqlite3";
import { log } from "./logging";
import { z } from "zod";

/**
Own durable schedule occurrences and their guarded delivery state transitions.
*/
export class ScheduleRuns {
  readonly claim;

  /**
Bind the concrete native database shared with schedule definitions.
@param db - Private native SQLite connection owning definition and occurrence transactions.
*/
  constructor(private db: Database.Database) {
    this.claim = this.db.transaction(this.claimOccurrence.bind(this));
  }

  /**
Allocate an occurrence identity only after its definition update successfully claims the due boundary.
@param schedule - Validated original schedule whose title, body and parent are retained.
@param scheduledAt - Exact due boundary captured before the guarded definition update.
@returns New persisted pending occurrence.
*/
  private recordRun(schedule: Schedule, scheduledAt: number) {
    const run: ScheduledRun = {
      id: crypto.randomUUID(),
      scheduleId: schedule.id,
      threadId: schedule.threadId,
      title: schedule.title,
      body: schedule.body,
      scheduledAt,
      status: "pending",
      error: null,
    };

    this.db
      .prepare("INSERT INTO scheduled_runs VALUES (@id,@scheduleId,@threadId,@title,@body,@scheduledAt,@status,@error)")
      .run(run);
    log().info({ run }, "schedule.due");

    return run;
  }

  /**
Atomically advance a matching active definition and record its due occurrence once.
@param schedule - Validated due definition with its original revision and next occurrence.
@param nextRun - Next native recurrence, or null when this definition is exhausted.
@param now - Current collection epoch retained in the definition update.
@returns New pending occurrence, or undefined when another collector already claimed the revision.
*/
  private claimOccurrence(schedule: Schedule, nextRun: number | null, now: number) {
    const scheduledAt = schedule.nextRun;

    if (scheduledAt === null) {
      throw new Error("A schedule without a next occurrence cannot be claimed.");
    }

    const updated = this.db
      .prepare(
        "UPDATE schedules SET nextRun=?, active=?, revision=revision+1, updatedAt=? WHERE id=? AND threadId=? AND revision=? AND active=1 AND nextRun=?"
      )
      .run(nextRun, Number(nextRun !== null), now, schedule.id, schedule.threadId, schedule.revision, schedule.nextRun);

    if (!updated.changes) {
      return;
    }

    return this.recordRun(schedule, scheduledAt);
  }

  /**
Read persisted occurrences belonging to one parent in chronological order.
@param threadId - Owning parent conversation identity.
@returns Validated occurrence history including its existing delivery state.
*/
  list(threadId: string) {
    return z
      .array(storedRun)
      .parse(this.db.prepare("SELECT * FROM scheduled_runs WHERE threadId=? ORDER BY scheduledAt, id").all(threadId));
  }

  /**
Persist the parent receipt's delivery outcome and existing diagnostic text.
@param id - Persisted occurrence identity shared with the parent message receipt.
@param status - Existing validated occurrence delivery state.
@param error - Optional diagnostic text, including legitimate null.
*/
  setStatus(id: string, status: ScheduledRun["status"], error: string | null = null) {
    this.db.prepare("UPDATE scheduled_runs SET status=?, error=? WHERE id=?").run(status, error, id);
    log().info({ id, status, error }, "schedule.delivery");
  }

  /**
Return interrupted dispatch claims to pending without replaying the parent's idempotent receipt.
@param threadId - Owning parent whose dispatch claims are being recovered.
*/
  recover(threadId: string) {
    this.db
      .prepare("UPDATE scheduled_runs SET status='pending' WHERE threadId=? AND status='dispatching'")
      .run(threadId);
  }

  /**
Claim dispatch only while an occurrence is still pending.
@param id - Persisted occurrence identity.
@returns Whether the guarded pending-to-dispatching transition succeeded.
*/
  begin(id: string) {
    return (
      this.db.prepare("UPDATE scheduled_runs SET status='dispatching' WHERE id=? AND status='pending'").run(id)
        .changes > 0
    );
  }
}
