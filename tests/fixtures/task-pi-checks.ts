import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { groupTaskContext, type TaskContextState } from "../../src/server/task-context";
import { contextEntrySchema, taskDirectory } from "../../src/server/task-archive";
import { scheduleTaskIndex, searchTaskArchivePage, settleTaskIndex } from "../../src/server/task-search";

/** Archive real Pi SDK ingestion and recover the native tool source through QMD.
@param owner - Parent whose native tool loop completed.
@param state - Production-ingested working context restored from disk.
*/
export async function checkPiTaskSearch(owner: string, state: TaskContextState) {
  await groupTaskContext(owner, state, () => Promise.resolve(true));
  const page = await searchTaskArchivePage(owner, "oldText");
  const hit = page.results.at(0);

  assert.ok(hit);
  const entry = contextEntrySchema.parse(JSON.parse(await readFile(hit.source.file, "utf8")));

  assert.equal(entry.id, hit.source.id);
  assert.equal(entry.role, "assistant");
  assert.match(JSON.stringify(entry.original), /oldText/);
  assert.match(hit.excerpt, /oldText/);
  await settleTaskIndex(owner);
}

/** Keep the real QMD worker waiting while a real Pi user/tool workflow completes independently.
@param owner - Parent whose background worker will encounter a held index lock.
@param operation - Real SDK message workflow that must not await that worker.
*/
export async function withIndexingPaused(owner: string, operation: () => Promise<void>) {
  const directory = path.join(taskDirectory(owner), "qmd");

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lock(directory);

  scheduleTaskIndex(owner);

  try {
    await operation();
  } finally {
    await release();
    await settleTaskIndex(owner);
  }
}
