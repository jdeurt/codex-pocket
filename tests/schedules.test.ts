import { type Schedule, ScheduleStore } from "../src/server/schedules";
import { type Snapshot, initialSnapshot } from "../src/lib/protocol";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { nextOccurrence, normalizeCalendar } from "../src/server/calendar";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { visibleSnapshot } from "../src/server/visible-snapshot";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const FIRST = Date.parse("2026-10-20T16:00:00Z");
const DAY_MS = 86_400_000;
const PRIVATE_MODE = 0o600;
const MODE_MASK = 0o777;
const input = { title: "Morning check", body: "Read the project status.", calendar: "DTSTART:20261020T160000Z" };

/**
Checks daily exclusions across the native Los Angeles daylight-saving transition.
*/
async function assertDstExclusion() {
  const repeating = normalizeCalendar(
    "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART;TZID=America/Los_Angeles:20261031T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE;TZID=America/Los_Angeles:20261101T090000\nEND:VEVENT\nEND:VCALENDAR"
  );

  assert.equal(await nextOccurrence(repeating, Date.parse("2026-10-31T16:00:00Z")), Date.parse("2026-11-02T17:00:00Z"));
}

await test("one-time events, recurring dates, exclusions and DST resolve to UTC instants", async () => {
  const once = normalizeCalendar(input.calendar);

  assert.equal(await nextOccurrence(once, NOW), FIRST);
  assert.equal(await nextOccurrence(once, FIRST), null);
  await assertDstExclusion();

  assert.equal(
    await nextOccurrence(normalizeCalendar(`${input.calendar}\nRDATE:20261022T180000Z`), FIRST),
    Date.parse("2026-10-22T18:00:00Z")
  );
});

await test("invalid dates, floating dates, timezones and ambiguous event shapes are rejected", () => {
  for (const calendar of [
    "DTSTART:20260230T090000Z",
    "DTSTART:20261020",
    "DTSTART:20261020T090000",
    "DTSTART;TZID=Invalid/Zone:20261020T090000",
    `${input.calendar}\n${input.calendar}`,
    `${input.calendar}\nRRULE:FREQ=DAILY;COUNT=0`,
    `${input.calendar}\nRRULE:FREQ=INVALID`,
    `${input.calendar}\nRRULE:FREQ=DAILY;INTERVAL=0`,
    `${input.calendar}\nRRULE:FREQ=DAILY;FOO=1`,
    `${input.calendar}\nRRULE:FREQ=DAILY;FREQ=WEEKLY`,
    `${input.calendar}\nRRULE:FREQ=DAILY;BYMONTHDAY=0`,
    `${input.calendar}\nRRULE:FREQ=DAILY;COUNT=2;UNTIL=20261021T090000Z`,
    `BEGIN:VEVENT\n${input.calendar}\nBEGIN:VALARM\nACTION:DISPLAY\nEND:VALARM\nEND:VEVENT`,
  ]) {
    assert.throws(() => normalizeCalendar(calendar));
  }
});

await test("recurrence computation is bounded so pathological rules cannot block the scheduler", async () => {
  const calendar = normalizeCalendar("DTSTART:20000101T000000Z\nRRULE:FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30");

  await assert.rejects(() => nextOccurrence(calendar, NOW), /too long/);
});

/**
Owns the native SQLite store across the durable schedule workflow's close/reopen boundary.
*/
class ScheduleStorageReplay {
  private store: ScheduleStore;
  private directory: string;

  /**
  Configures private diagnostics before opening this workflow's native store.
  @param directory - Fresh private directory owned by the enclosing workflow.
  */
  constructor(directory: string) {
    this.directory = directory;
    process.env.CODEX_POCKET_LOG_DIR = path.join(directory, "logs");
    this.store = new ScheduleStore(directory);
  }

  /**
  Check the native database file's owner-only mode after schedule creation.
  */
  private async checkPrivateFile() {
    const metadata = await stat(path.join(this.directory, "schedules.sqlite"));

    assert.equal(metadata.mode & MODE_MASK, PRIVATE_MODE);
  }

  /**
  Check the created schedule and parent isolation before pausing it.
  @param job - Canonical created schedule with its original revision.
  @returns Native paused schedule.
  */
  private async pause(job: Schedule) {
    assert.equal(job.nextRun, FIRST);
    await this.checkPrivateFile();
    assert.throws(() => this.store.get("thread-b", job.id), /not found/);
    assert.deepEqual(this.store.list("thread-b"), []);

    return this.store.update("thread-a", job.id, { active: false, title: "Paused check" }, job.revision, NOW);
  }

  /**
  Verify the paused state before a title-only update using the current native revision.
  @param job - Original created identity.
  @param paused - Canonical pause result.
  @returns Native renamed schedule.
  */
  private rename(job: Schedule, paused: Schedule) {
    assert.equal(paused.active, 0);

    return this.store.update("thread-a", job.id, { title: "Paused check" }, paused.revision, NOW);
  }

  /**
  Reject the stale original revision before resuming the still-paused schedule.
  @param job - Original schedule identity and stale revision.
  @param renamed - Canonical title update carrying the current revision.
  @returns Native resumed schedule.
  */
  private async resume(job: Schedule, renamed: Schedule) {
    assert.equal(renamed.active, 0);
    await assert.rejects(() => this.store.update("thread-a", job.id, { title: "Stale" }, job.revision, NOW), /changed/);

    return this.store.update("thread-a", job.id, { active: true }, renamed.revision, NOW);
  }

  /**
  Reopen the native database and require the saved revision/due state before claiming its occurrence.
  @param job - Original schedule identity.
  @param resumed - Canonical revision persisted before store closure.
  @returns Native durable occurrence claim, required by the following workflow assertions.
  */
  private reopenAndClaim(job: Schedule, resumed: Schedule) {
    this.store.close();
    this.store = new ScheduleStore(this.directory);
    assert.equal(this.store.get("thread-a", job.id).revision, resumed.revision);
    assert.equal(this.store.due("thread-a", FIRST).length, 1);

    return this.store.occurrences.claim(resumed, null, FIRST);
  }

  /**
  Close the current native store, including its reopened replacement.
  */
  close() {
    this.store.close();
  }

  /**
  Exercise revision-checked CRUD, persisted reopen, occurrence recovery and retained delivery history.
  */
  async check() {
    const job = await this.store.create("thread-a", input, NOW);
    const paused = await this.pause(job);
    const renamed = await this.rename(job, paused);
    const resumed = await this.resume(job, renamed);
    const run = this.reopenAndClaim(job, resumed);

    assert.ok(run);
    assert.equal(this.store.get("thread-a", job.id).active, 0);
    assert.equal(this.store.occurrences.claim(resumed, null, FIRST), undefined);
    assert.equal(this.store.occurrences.begin(run.id), true);
    this.store.occurrences.recover("thread-a");
    assert.equal(this.store.occurrences.list("thread-a")[0].status, "pending");
    this.store.occurrences.setStatus(run.id, "sent");
    this.store.delete("thread-a", job.id);
    assert.equal(this.store.list("thread-a").length, 0);
    assert.equal(this.store.occurrences.list("thread-a")[0].title, "Paused check");
    assert.equal(this.store.occurrences.list("thread-a")[0].status, "sent");
    await assert.rejects(() => this.store.create("thread-a", input, FIRST + DAY_MS), /no future/);
  }
}

await test("schedule CRUD is scoped, revision checked, durable and owner private", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-schedules-"));
  const replay = new ScheduleStorageReplay(directory);

  try {
    await replay.check();
  } finally {
    replay.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("scheduled triggers stay hidden while ordinary messages, replies and prompts remain visible", () => {
  const state: Snapshot = {
    ...structuredClone(initialSnapshot),
    scheduled: { "run-id": { title: "Morning check", scheduledAt: FIRST } },
    queue: [
      { id: "run-id", text: "private injected instructions", status: "queued" },
      { id: "phone-id", text: "Phone follow-up", status: "sending" },
    ],
    requests: [{ id: "question", method: "item/tool/requestUserInput", params: { questions: [] } }],
    turns: [
      {
        id: "turn",
        status: "completed",
        items: [
          {
            id: "item",
            type: "userMessage",
            clientId: "run-id",
            content: [{ type: "text", text: "private injected instructions" }],
          },
          { id: "reply", type: "agentMessage", text: "Task complete." },
          { id: "phone", type: "userMessage", clientId: "ordinary-id", content: [{ type: "text", text: "Hello" }] },
        ],
      },
    ],
  };
  const original = structuredClone(state);
  const visible = visibleSnapshot(state);

  assert.equal(JSON.stringify(visible).includes("private injected instructions"), false);
  assert.equal(JSON.stringify(visible).includes("Morning check"), false);
  assert.deepEqual(visible.turns[0].items, state.turns[0].items.slice(1));
  assert.deepEqual(visible.queue, [state.queue[1]]);
  assert.deepEqual(visible.requests, state.requests);
  assert.deepEqual(visible.scheduled, {});
  assert.deepEqual(state, original);

  for (const status of ["sending", "unknown", "sent"] as const) {
    state.queue[0].status = status;
    assert.deepEqual(visibleSnapshot(state).queue, [state.queue[1]]);
  }

  assert.deepEqual(visibleSnapshot(visible), visible);
});
