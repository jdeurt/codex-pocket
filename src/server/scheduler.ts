import type { Bridge } from "./bridge";
import type { ScheduleStore } from "./schedules";
import { log } from "./logging";
import { nextOccurrence } from "./calendar";

const INTERVAL_MS = 1000;

export class Scheduler {
  private running = false;
  private timer?: NodeJS.Timeout;
  constructor(
    private store: ScheduleStore,
    private bridge: Bridge,
    private threadId: string
  ) {}
  private async collectDue(now: number) {
    for (const schedule of this.store.due(this.threadId, now)) {
      try {
        const next = await nextOccurrence(schedule.calendar, now);
        this.store.claim(schedule, next, now);
      } catch (error) {
        log().error({ id: schedule.id, error }, "schedule.recurrence_failed");
        await this.store.update(this.threadId, schedule.id, { active: false }, schedule.revision);
      }
    }

    this.bridge.refreshScheduled();
  }
  private async dispatch() {
    const pending = this.store.runs(this.threadId).filter((entry) => ["pending", "queued"].includes(entry.status));

    for (const run of pending) {
      if (run.status === "pending" && !this.store.beginRun(run.id)) {
        continue;
      }

      try {
        const delivered = await this.bridge.send(run.id, run.body);
        this.store.setRun(run.id, delivered.status === "sending" ? "unknown" : delivered.status);
      } catch (error) {
        // Bridge persists uncertain sends; retrying this same ID only reads that receipt.
        this.store.setRun(run.id, "pending", error instanceof Error ? error.message : String(error));
        break;
      }
    }
  }
  start() {
    this.store.recover(this.threadId);
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }
  async tick(now = Date.now()) {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      await this.collectDue(now);
      await this.dispatch();
    } catch (error) {
      log().error({ error }, "schedule.tick_failed");
    } finally {
      this.running = false;
    }
  }
  stop() {
    clearInterval(this.timer);
  }
}
