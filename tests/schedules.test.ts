import { mkdtemp, rm, stat } from "node:fs/promises";
import { nextOccurrence, normalizeCalendar } from "../src/server/calendar";
import { ScheduleStore } from "../src/server/schedules";
import assert from "node:assert/strict";
import { initialSnapshot } from "../src/lib/protocol";
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

test("one-time events, recurring dates, exclusions and DST resolve to UTC instants", async () => {
  const once = normalizeCalendar(input.calendar);
  assert.equal(await nextOccurrence(once, NOW), FIRST);
  assert.equal(await nextOccurrence(once, FIRST), null);
  const repeating = normalizeCalendar(
    "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART;TZID=America/Los_Angeles:20261031T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE;TZID=America/Los_Angeles:20261101T090000\nEND:VEVENT\nEND:VCALENDAR"
  );
  assert.equal(await nextOccurrence(repeating, Date.parse("2026-10-31T16:00:00Z")), Date.parse("2026-11-02T17:00:00Z"));
  const additional = normalizeCalendar(`${input.calendar}\nRDATE:20261022T180000Z`);
  assert.equal(await nextOccurrence(additional, FIRST), Date.parse("2026-10-22T18:00:00Z"));
});

test("invalid dates, floating dates, timezones and ambiguous event shapes are rejected", () => {
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

test("recurrence computation is bounded so pathological rules cannot block the scheduler", async () => {
  const calendar = normalizeCalendar("DTSTART:20000101T000000Z\nRRULE:FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30");
  await assert.rejects(() => nextOccurrence(calendar, NOW), /too long/);
});

test("schedule CRUD is scoped, revision checked, durable and owner private", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-schedules-"));
  process.env.CODEX_POCKET_LOG_DIR = path.join(directory, "logs");
  let store = new ScheduleStore(directory);

  try {
    const job = await store.create("thread-a", input, NOW);
    assert.equal(job.nextRun, FIRST);
    const metadata = await stat(path.join(directory, "schedules.sqlite"));
    assert.equal(metadata.mode & MODE_MASK, PRIVATE_MODE);
    assert.throws(() => store.get("thread-b", job.id), /not found/);
    assert.deepEqual(store.list("thread-b"), []);
    const paused = await store.update("thread-a", job.id, { active: false, title: "Paused check" }, job.revision, NOW);
    assert.equal(paused.active, 0);
    const renamed = await store.update("thread-a", job.id, { title: "Paused check" }, paused.revision, NOW);
    assert.equal(renamed.active, 0);
    await assert.rejects(() => store.update("thread-a", job.id, { title: "Stale" }, job.revision, NOW), /changed/);
    const resumed = await store.update("thread-a", job.id, { active: true }, renamed.revision, NOW);
    store.close();
    store = new ScheduleStore(directory);
    assert.equal(store.get("thread-a", job.id).revision, resumed.revision);
    assert.equal(store.due("thread-a", FIRST).length, 1);
    const run = store.claim(resumed, null, FIRST);
    assert.ok(run);
    assert.equal(store.get("thread-a", job.id).active, 0);
    assert.equal(store.claim(resumed, null, FIRST), undefined);
    assert.equal(store.beginRun(run.id), true);
    store.recover("thread-a");
    assert.equal(store.runs("thread-a")[0].status, "pending");
    store.setRun(run.id, "sent");
    store.delete("thread-a", job.id);
    assert.equal(store.list("thread-a").length, 0);
    assert.equal(store.runs("thread-a")[0].title, "Paused check");
    assert.equal(store.runs("thread-a")[0].status, "sent");
    await assert.rejects(() => store.create("thread-a", input, FIRST + DAY_MS), /no future/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduled triggers stay hidden while ordinary messages, replies and prompts remain visible", () => {
  const state = structuredClone(initialSnapshot);
  state.scheduled["run-id"] = { title: "Morning check", scheduledAt: FIRST };
  state.queue = [
    { id: "run-id", text: "private injected instructions", status: "queued" },
    { id: "phone-id", text: "Phone follow-up", status: "sending" },
  ];
  state.requests = [{ id: "question", method: "item/tool/requestUserInput", params: { questions: [] } }];
  state.turns = [
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
  ];
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
