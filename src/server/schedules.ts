import { chmodSync, mkdirSync } from "node:fs";
import { nextOccurrence, normalizeCalendar } from "./calendar";
import Database from "better-sqlite3";
import { localDirectory } from "./local-state";
import { log } from "./logging";
import path from "node:path";
import { z } from "zod";

const BUSY_TIMEOUT_MS = 1000;
const DUE_BATCH_SIZE = 20;
const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 32_768;
const MAX_CALENDAR_LENGTH = 16_384;
const PRIVATE_FILE_MODE = 0o600;
export const scheduleInput = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
    calendar: z.string().min(1).max(MAX_CALENDAR_LENGTH),
    active: z.boolean().default(true),
  })
  .strict();
export const schedulePatch = scheduleInput
  .omit({ active: true })
  .partial()
  .extend({ active: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one change.");
export interface Schedule {
  id: string;
  threadId: string;
  title: string;
  body: string;
  calendar: string;
  active: number;
  nextRun: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface ScheduledRun {
  id: string;
  scheduleId: string;
  threadId: string;
  title: string;
  body: string;
  scheduledAt: number;
  status: "pending" | "dispatching" | "queued" | "sent" | "unknown" | "cancelled";
  error: string | null;
}

export class ScheduleStore {
  private db: Database.Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, "schedules.sqlite");
    this.db = new Database(filename, { timeout: BUSY_TIMEOUT_MS });
    chmodSync(filename, PRIVATE_FILE_MODE);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, threadId TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        calendar TEXT NOT NULL, active INTEGER NOT NULL, nextRun INTEGER, revision INTEGER NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(threadId, active, nextRun);
      CREATE TABLE IF NOT EXISTS scheduled_runs (
        id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL, threadId TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, scheduledAt INTEGER NOT NULL, status TEXT NOT NULL, error TEXT,
        UNIQUE(scheduleId, scheduledAt)
      );
      CREATE INDEX IF NOT EXISTS scheduled_runs_thread ON scheduled_runs(threadId, status);
    `);
  }
  list(threadId: string) {
    return this.db
      .prepare("SELECT * FROM schedules WHERE threadId = ? ORDER BY createdAt, id")
      .all(threadId) as Schedule[];
  }
  get(threadId: string, id: string) {
    const row = this.db.prepare("SELECT * FROM schedules WHERE threadId = ? AND id = ?").get(threadId, id) as
      Schedule | undefined;

    if (!row) {
      throw new Error("Schedule not found in this Pocket chat.");
    }

    return row;
  }
  async create(threadId: string, input: unknown, now = Date.now()) {
    const value = scheduleInput.parse(input);
    const calendar = normalizeCalendar(value.calendar);
    const nextRun = await nextOccurrence(calendar, now);

    if (value.active && nextRun === null) {
      throw new Error("This event has no future occurrences. Choose a future DTSTART or recurrence.");
    }

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
  async update(threadId: string, id: string, input: unknown, expectedRevision?: number, now = Date.now()) {
    const patch = schedulePatch.parse(input);
    const previous = this.get(threadId, id);

    if (expectedRevision !== undefined && expectedRevision !== previous.revision) {
      throw new Error("Schedule changed. Read it again before updating.");
    }

    const calendar = patch.calendar === undefined ? previous.calendar : normalizeCalendar(patch.calendar);
    const active = patch.active === undefined ? previous.active : Number(patch.active);
    const nextRun =
      patch.calendar !== undefined || (active && !previous.active)
        ? await nextOccurrence(calendar, now)
        : previous.nextRun;

    if (active && nextRun === null) {
      throw new Error("This event has no future occurrences.");
    }

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
  delete(threadId: string, id: string) {
    return this.db.transaction(() => {
      this.get(threadId, id);
      this.db.prepare("DELETE FROM schedules WHERE threadId=? AND id=?").run(threadId, id);
      const result = this.db
        .prepare("UPDATE scheduled_runs SET status='cancelled' WHERE threadId=? AND scheduleId=? AND status='pending'")
        .run(threadId, id);
      log().info({ threadId, id, cancelledPending: result.changes }, "schedule.deleted");

      return {
        id,
        deleted: true,
        cancelledPending: result.changes,
        note: "Already accepted or in-flight messages cannot be withdrawn. Historical markers are retained.",
      };
    })();
  }
  due(threadId: string, now: number) {
    return this.db
      .prepare("SELECT * FROM schedules WHERE threadId=? AND active=1 AND nextRun<=? ORDER BY nextRun LIMIT ?")
      .all(threadId, now, DUE_BATCH_SIZE) as Schedule[];
  }
  claim(schedule: Schedule, nextRun: number | null, now: number) {
    return this.db.transaction(() => {
      const updated = this.db
        .prepare(
          "UPDATE schedules SET nextRun=?, active=?, revision=revision+1, updatedAt=? WHERE id=? AND threadId=? AND revision=? AND active=1 AND nextRun=?"
        )
        .run(
          nextRun,
          Number(nextRun !== null),
          now,
          schedule.id,
          schedule.threadId,
          schedule.revision,
          schedule.nextRun
        );

      if (!updated.changes) {
        return;
      }

      const run: ScheduledRun = {
        id: crypto.randomUUID(),
        scheduleId: schedule.id,
        threadId: schedule.threadId,
        title: schedule.title,
        body: schedule.body,
        scheduledAt: schedule.nextRun as number,
        status: "pending",
        error: null,
      };
      this.db
        .prepare(
          "INSERT INTO scheduled_runs VALUES (@id,@scheduleId,@threadId,@title,@body,@scheduledAt,@status,@error)"
        )
        .run(run);
      log().info({ run }, "schedule.due");

      return run;
    })();
  }
  runs(threadId: string) {
    return this.db
      .prepare("SELECT * FROM scheduled_runs WHERE threadId=? ORDER BY scheduledAt, id")
      .all(threadId) as ScheduledRun[];
  }
  setRun(id: string, status: ScheduledRun["status"], error: string | null = null) {
    this.db.prepare("UPDATE scheduled_runs SET status=?, error=? WHERE id=?").run(status, error, id);
    log().info({ id, status, error }, "schedule.delivery");
  }
  recover(threadId: string) {
    this.db
      .prepare("UPDATE scheduled_runs SET status='pending' WHERE threadId=? AND status='dispatching'")
      .run(threadId);
  }
  beginRun(id: string) {
    return (
      this.db.prepare("UPDATE scheduled_runs SET status='dispatching' WHERE id=? AND status='pending'").run(id)
        .changes > 0
    );
  }
  close() {
    this.db.close();
  }
}

declare global {
  var codexPocketSchedules: ScheduleStore | undefined;
}

export function schedules() {
  if (!globalThis.codexPocketSchedules) {
    Object.defineProperty(globalThis, "codexPocketSchedules", {
      value: new ScheduleStore(localDirectory()),
      configurable: true,
    });
  }

  return globalThis.codexPocketSchedules as ScheduleStore;
}
