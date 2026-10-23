import { ScheduleStore } from "../src/server/schedules";
import { mkdtemp, rm, stat } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const FIRST = Date.parse("2026-10-20T16:00:00Z");
const DAY_MS = 86_400_000;
const PRIVATE_MODE = 0o600;
const MODE_MASK = 0o777;
const input = { title: "Morning check", body: "Read the project status.", calendar: "DTSTART:20261020T160000Z" };

await test("schedule CRUD retains revisions and occurrence history across database reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-schedules-"));

  process.env.CODEX_POCKET_LOG_DIR = path.join(directory, "logs");
  let store = new ScheduleStore(directory);

  try {
    const job = await store.create("thread-a", input, NOW);
    const metadata = await stat(path.join(directory, "schedules.sqlite"));

    assert.equal(job.nextRun, FIRST);
    assert.equal(metadata.mode & MODE_MASK, PRIVATE_MODE);
    assert.throws(() => store.get("thread-b", job.id), /not found/);
    const paused = await store.update("thread-a", job.id, { active: false }, job.revision, NOW);
    const renamed = await store.update("thread-a", job.id, { title: "Paused check" }, paused.revision, NOW);

    assert.equal(renamed.active, 0);
    await assert.rejects(() => store.update("thread-a", job.id, { title: "Stale" }, job.revision, NOW), /changed/);
    const resumed = await store.update("thread-a", job.id, { active: true }, renamed.revision, NOW);

    store.close();
    store = new ScheduleStore(directory);
    assert.equal(store.get("thread-a", job.id).revision, resumed.revision);
    assert.equal(store.due("thread-a", FIRST).length, 1);
    const run = store.occurrences.claim(resumed, null, FIRST);

    assert.ok(run);
    assert.equal(store.get("thread-a", job.id).active, 0);
    assert.equal(store.occurrences.claim(resumed, null, FIRST), undefined);
    assert.equal(store.occurrences.begin(run.id), true);
    store.occurrences.recover("thread-a");
    assert.equal(store.occurrences.list("thread-a")[0].status, "pending");
    store.occurrences.setStatus(run.id, "sent");
    store.delete("thread-a", job.id);
    assert.equal(store.list("thread-a").length, 0);
    assert.equal(store.occurrences.list("thread-a")[0].title, "Paused check");
    assert.equal(store.occurrences.list("thread-a")[0].status, "sent");
    await assert.rejects(() => store.create("thread-a", input, FIRST + DAY_MS), /no future/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
