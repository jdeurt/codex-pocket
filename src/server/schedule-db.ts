import { chmodSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";
import { z } from "zod";

const BUSY_TIMEOUT_MS = 1000;
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
export const scheduleSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  title: z.string(),
  body: z.string(),
  calendar: z.string(),
  active: z.number().int(),
  nextRun: z.number().nullable(),
  revision: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Schedule = z.infer<typeof scheduleSchema>;
export const storedRun = z.object({
  id: z.string(),
  scheduleId: z.string(),
  threadId: z.string(),
  title: z.string(),
  body: z.string(),
  scheduledAt: z.number(),
  status: z.enum(["pending", "dispatching", "queued", "sent", "unknown", "cancelled"]),
  error: z.string().nullable(),
});

export type ScheduledRun = z.infer<typeof storedRun>;

/**
Acquire the private SQLite file and initialize the existing schedule and occurrence tables.
@param filename - Native database filename inside the already-created private directory.
@returns Native private database handle configured for WAL and bounded busy waiting.
*/
function openScheduleDatabase(filename: string) {
  const db = new Database(filename, { timeout: BUSY_TIMEOUT_MS });

  chmodSync(filename, PRIVATE_FILE_MODE);
  db.pragma("journal_mode = WAL");
  db.exec(`
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

  return db;
}

/**
Create the private state directory before opening its schedule database.
@param directory - Private state directory owned by this process or isolated fixture.
@returns Initialized native schedule database handle.
*/
export function scheduleDatabase(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  return openScheduleDatabase(path.join(directory, "schedules.sqlite"));
}
