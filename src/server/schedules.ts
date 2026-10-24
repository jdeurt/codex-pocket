import { type Schedule, scheduleDatabase, scheduleInput, schedulePatch, scheduleSchema } from "./schedule-db";
import { nextOccurrence, normalizeCalendar } from "./calendar";
import type Database from "better-sqlite3";
import { ScheduleRuns } from "./schedule-runs";
import { localDirectory } from "./local-state";
import { log } from "./logging";
import { z } from "zod";

const DUE_BATCH_SIZE = 20;

export { type Schedule, type ScheduledRun, scheduleInput, schedulePatch, scheduleSchema } from "./schedule-db";

/**
Own parent-scoped schedule definitions and their concrete persisted occurrence resource.
*/
export class ScheduleStore {
  private db: Database.Database;
  readonly delete;

  readonly occurrences: ScheduleRuns;

  /**
Acquire private schedule persistence and bind its occurrence owner without starting dispatch.
@param directory - Private state directory for this schedule owner.
*/
  constructor(directory: string) {
    this.db = scheduleDatabase(directory);
    this.delete = this.db.transaction(this.deleteSchedule.bind(this));
    this.occurrences = new ScheduleRuns(this.db);
  }

  /**
Persist a validated schedule only after its native recurrence and active-state guards succeed.
@param threadId - Owning parent conversation identity.
@param value - Validated creation input from the shared schedule schema.
@param calendar - Normalized recurrence text already checked by the native calendar boundary.
@param nextRun - Computed next occurrence, or null for a permitted inactive schedule.
@param now - Original creation epoch captured by the public operation.
@returns Persisted normalized schedule with its new stable identity.
*/
  private insertSchedule(
    threadId: string,
    value: z.infer<typeof scheduleInput>,
    calendar: string,
    nextRun: number | null,
    now: number
  ) {
    const row: Schedule = {
      ...value,
      calendar,
      active: Number(value.active),
      nextRun,
      id: crypto.randomUUID(),
      threadId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        "INSERT INTO schedules VALUES (@id,@threadId,@title,@body,@calendar,@active,@nextRun,@revision,@createdAt,@updatedAt)"
      )
      .run(row);
    log().info({ schedule: row }, "schedule.created");

    return row;
  }

  /**
Compute only the recurrence changes required by a validated, revision-checked patch.
@param previous - Existing parent-owned schedule read before asynchronous recurrence work.
@param patch - Validated partial input retaining omitted field semantics.
@param now - Original update epoch captured by the public operation.
@returns Persisted updated schedule after recurrence and compare-and-swap checks.
*/
  private async applyPatch(previous: Schedule, patch: z.infer<typeof schedulePatch>, now: number) {
    const calendar = patch.calendar === undefined ? previous.calendar : normalizeCalendar(patch.calendar);
    const active = patch.active === undefined ? previous.active : Number(patch.active);
    const nextRun =
      patch.calendar !== undefined || (active && !previous.active)
        ? await nextOccurrence(calendar, now)
        : previous.nextRun;

    if (active && nextRun === null) {
      throw new Error("This event has no future occurrences.");
    }

    return this.persistPatch(previous, patch, calendar, active, nextRun, now);
  }

  /**
Apply a normalized patch only while the original persisted revision still matches.
@param previous - Original parent-owned schedule whose revision guards the write.
@param patch - Validated partial input.
@param calendar - Normalized retained or replacement recurrence.
@param active - Existing integer active-state representation.
@param nextRun - Retained or recomputed next occurrence, including legitimate null.
@param now - Original update epoch.
@returns Persisted updated schedule, or the existing concurrent-change error.
*/
  private persistPatch(
    previous: Schedule,
    patch: z.infer<typeof schedulePatch>,
    calendar: string,
    active: number,
    nextRun: number | null,
    now: number
  ) {
    const row: Schedule = {
      ...previous,
      ...patch,
      calendar,
      active,
      nextRun,
      revision: previous.revision + 1,
      updatedAt: now,
    };
    const result = this.db
      .prepare(
        `UPDATE schedules SET title=@title, body=@body, calendar=@calendar, active=@active,
      nextRun=@nextRun, revision=@revision, updatedAt=@updatedAt WHERE id=@id AND threadId=@threadId AND revision=@previousRevision`
      )
      .run({ ...row, previousRevision: previous.revision });

    if (!result.changes) {
      throw new Error("Schedule changed. Read it again before updating.");
    }

    log().info({ schedule: row }, "schedule.updated");

    return row;
  }

  /**
Acknowledge deletion only after the native transaction cancels its still-pending occurrences.
@param threadId - Owning parent identity used for diagnostics.
@param id - Deleted schedule identity.
@param result - Native SQLite result of cancelling only pending occurrences.
@returns Existing deletion acknowledgement retaining historical and in-flight delivery limitations.
*/
  private deletionReceipt(threadId: string, id: string, result: Database.RunResult) {
    log().info({ threadId, id, cancelledPending: result.changes }, "schedule.deleted");

    return {
      id,
      deleted: true,
      cancelledPending: result.changes,
      note: "Already accepted or in-flight messages cannot be withdrawn. Historical markers are retained.",
    };
  }

  /**
Atomically remove an owned definition and cancel only its still-pending occurrences.
@param threadId - Owning parent identity.
@param id - Owned schedule identity.
@returns Deletion acknowledgement retaining historical and already accepted delivery records.
*/
  private deleteSchedule(threadId: string, id: string) {
    this.get(threadId, id);
    this.db.prepare("DELETE FROM schedules WHERE threadId=? AND id=?").run(threadId, id);

    return this.deletionReceipt(
      threadId,
      id,
      this.db
        .prepare("UPDATE scheduled_runs SET status='cancelled' WHERE threadId=? AND scheduleId=? AND status='pending'")
        .run(threadId, id)
    );
  }

  /**
Read normalized schedule definitions belonging to one parent conversation.
@param threadId - Owning parent conversation identity.
@returns Validated schedules in deterministic creation order.
*/
  list(threadId: string) {
    return z
      .array(scheduleSchema)
      .parse(this.db.prepare("SELECT * FROM schedules WHERE threadId = ? ORDER BY createdAt, id").all(threadId));
  }

  /**
Require a validated schedule under the exact parent scope.
@param threadId - Owning parent identity.
@param id - Schedule identity requested in that parent.
@returns Normalized persisted schedule or the existing ownership error.
*/
  get(threadId: string, id: string) {
    const row = this.db.prepare("SELECT * FROM schedules WHERE threadId = ? AND id = ?").get(threadId, id);

    if (!row) {
      throw new Error("Schedule not found in this Pocket chat.");
    }

    return scheduleSchema.parse(row);
  }

  /**
Validate input and native recurrence before allocating and persisting a schedule identity.
@param threadId - Owning parent conversation identity.
@param input - Untrusted creation input.
@param now - Creation epoch, defaulting to the native current time.
@returns New persisted schedule after active schedules are shown to have a future occurrence.
*/
  async create(threadId: string, input: unknown, now = Date.now()) {
    const value = scheduleInput.parse(input);
    const calendar = normalizeCalendar(value.calendar);
    const nextRun = await nextOccurrence(calendar, now);

    if (nextRun === null && value.active) {
      throw new Error("This event has no future occurrences. Choose a future DTSTART or recurrence.");
    }

    return this.insertSchedule(threadId, value, calendar, nextRun, now);
  }

  /**
Validate parent ownership and the expected revision before asynchronous recurrence work.
@param threadId - Owning parent identity.
@param id - Schedule identity in that parent.
@param input - Untrusted partial update input.
@param expectedRevision - Optional caller revision checked before recurrence evaluation.
@param now - Update epoch, defaulting to native current time.
@returns Updated schedule with its original identity and incremented persisted revision.
*/
  async update(threadId: string, id: string, input: unknown, expectedRevision?: number, now = Date.now()) {
    const patch = schedulePatch.parse(input);
    const previous = this.get(threadId, id);

    if (expectedRevision !== undefined && expectedRevision !== previous.revision) {
      throw new Error("Schedule changed. Read it again before updating.");
    }

    return this.applyPatch(previous, patch, now);
  }

  /**
Read the bounded earliest due active schedules for one parent.
@param threadId - Owning parent identity.
@param now - Current epoch boundary used for due selection.
@returns Validated due schedule definitions within the existing dispatch batch limit.
*/
  due(threadId: string, now: number) {
    return z
      .array(scheduleSchema)
      .parse(
        this.db
          .prepare("SELECT * FROM schedules WHERE threadId=? AND active=1 AND nextRun<=? ORDER BY nextRun LIMIT ?")
          .all(threadId, now, DUE_BATCH_SIZE)
      );
  }

  /**
Release this owner's native schedule database handle.
*/
  close() {
    this.db.close();
  }
}

declare global {
  var codexPocketSchedules: ScheduleStore | undefined;
}

/**
Acquire and register the process's private schedule owner on first use.
@returns Newly registered concrete schedule store.
*/
function createScheduleStore() {
  const store = new ScheduleStore(localDirectory());

  Object.defineProperty(globalThis, "codexPocketSchedules", { value: store, configurable: true });

  return store;
}

/**
Reuse the process's existing private schedule owner or create it lazily.
@returns Process-local schedule persistence owner.
*/
export function schedules() {
  return globalThis.codexPocketSchedules ?? createScheduleStore();
}
