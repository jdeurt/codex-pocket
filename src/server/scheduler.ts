import { t as attempt } from "try";
import type { ScheduleStore, ScheduledRun } from "./schedules";
import type { Bridge } from "./bridge";
import { log } from "./logging";
import { nextOccurrence } from "./calendar";

const INTERVAL_MS = 1000;

/**
Own due schedule collection and serial receipt dispatch for one configured parent.
*/
export class Scheduler {
  private running = false;

  private timer?: NodeJS.Timeout;

  /**
Bind the existing schedule store and parent bridge without starting timers or dispatching work.
@param store - Private schedule and occurrence store.
@param bridge - Existing parent bridge owning idempotent native delivery.
@param threadId - Configured parent whose schedules alone may execute.
*/
  constructor(
    private store: ScheduleStore,
    private bridge: Bridge,
    private threadId: string
  ) {}

  /**
Claim due occurrences and disable invalid recurrences before refreshing the parent's schedule projection.
@param now - Current occurrence boundary in epoch milliseconds.
*/
  private async collectDue(now: number) {
    for (const schedule of this.store.due(this.threadId, now)) {
      await (async () => {
        const next = await nextOccurrence(schedule.calendar, now);

        this.store.occurrences.claim(schedule, next, now);
      })().catch(async (error: unknown) => {
        log().error({ id: schedule.id, error }, "schedule.recurrence_failed");
        await this.store.update(this.threadId, schedule.id, { active: false }, schedule.revision);
      });
    }

    this.bridge.refreshScheduled();
  }

  /**
Dispatch one persisted occurrence and retain the bridge's existing delivery status mapping.
@param run - Claimed occurrence whose stable ID is shared with the parent receipt.
*/
  private async dispatchRun(run: ScheduledRun) {
    const delivered = await this.bridge.send(run.id, run.body);

    this.store.occurrences.setStatus(run.id, delivered.status === "sending" ? "unknown" : delivered.status);
  }

  /**
Dispatch persisted pending occurrences serially through the parent's idempotent receipt boundary.
*/
  private async dispatch() {
    const pending = this.store.occurrences
      .list(this.threadId)
      .filter((entry) => ["pending", "queued"].includes(entry.status));

    for (const run of pending) {
      if (run.status === "pending" && !this.store.occurrences.begin(run.id)) {
        continue;
      }

      const delivered = await attempt(() => this.dispatchRun(run));

      if (!delivered.ok) {
        const error = delivered.error;

        // Bridge persists uncertain sends; retrying this same ID only reads that receipt.
        this.store.occurrences.setStatus(run.id, "pending", error instanceof Error ? error.message : String(error));
        break;
      }
    }
  }

  /**
Recover interrupted occurrence records and acquire the existing unrefed polling timer.
*/
  start() {
    this.store.occurrences.recover(this.threadId);
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  /**
Run one non-overlapping due-collection and dispatch cycle, retaining diagnostic failures.
@param now - Occurrence boundary in epoch milliseconds, defaulting to current native time.
*/
  async tick(now = Date.now()) {
    if (this.running) {
      return;
    }

    this.running = true;

    await (async () => {
      await this.collectDue(now);
      await this.dispatch();
    })()
      .catch((error: unknown) => {
        log().error({ error }, "schedule.tick_failed");
      })
      .finally(() => {
        this.running = false;
      });
  }

  /**
Release this scheduler's owned polling timer.
*/
  stop() {
    clearInterval(this.timer);
  }
}
