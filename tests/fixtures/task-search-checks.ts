import { checkTaskMcp } from "./task-mcp-checks";
import { checkQmdHybrid } from "./task-qmd-checks";
import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { contextEntrySchema, taskDirectory, writeTaskFile } from "../../src/server/task-archive";
import { searchTaskArchivePage, settleTaskIndex } from "../../src/server/task-search";
import { readTaskArchive } from "../../src/server/task-archive-read";
import { type TaskIndexDocument, reconcileTaskViews } from "../../src/server/task-index-views";
import { searchTaskIndex } from "../../src/server/task-index-search";
import { createStore } from "@tobilu/qmd";

/** Run production retrieval against an actual local QMD index with a known capability mode.
@param store - Existing SDK store.
@param owner - Parent identity.
@param documents - Current page/source mapping.
@returns Source-validated keyword results.
*/
function queryStore(store: Awaited<ReturnType<typeof createStore>>, owner: string, documents: TaskIndexDocument[]) {
  return searchTaskIndex(store, owner, documents, "late-calendar-needle", 0, {
    engine: "@tobilu/qmd",
    mode: "keyword",
    reranked: false,
    reasons: ["Local models not installed in this workflow"],
  });
}

/** Verify stale view validation after indexing but before result projection, without mocking QMD retrieval.
@param owner - Parent with persisted QMD documents.
*/
async function checkStaleCandidate(owner: string) {
  const documents = await reconcileTaskViews(owner);
  const store = await createStore({ dbPath: path.join(taskDirectory(owner), "qmd", "index.sqlite") });
  const document = documents.find((entry) => entry.body.includes("late-calendar-needle"));

  assert.ok(document);
  const old = await readFile(document.taskFile, "utf8");

  try {
    await store.update();
    await checkQmdHybrid(store, owner, documents);
    await writeFile(document.taskFile, old + "\nChanged concurrently\n");
    const result = await queryStore(store, owner, documents);

    assert.ok(result.results.every((entry) => entry.taskFile !== document.taskFile));
  } finally {
    await writeFile(document.taskFile, old);
    await store.close();
  }
}

/** Verify restart-style reconciliation, changed/deleted views and stale candidate rejection through QMD itself.
@param owner - Isolated archive owner.
@param taskName - Existing task to preserve during the checks.
*/
async function checkReconciliation(owner: string, taskName: string) {
  const directory = taskDirectory(owner);
  const file = path.join(directory, "historical.md");
  const archived = await readTaskArchive(path.join(directory, taskName));
  const original = archived.entries[0];
  const text = "restartreconciliationtoken";
  const entries = [{ ...original, text, original: { role: "user", content: text } }];

  // Simulate an older archive committed before an index wakeup or process restart.
  await writeTaskFile(directory, "historical.md", "# Old archive\n\n```json\n" + JSON.stringify(entries) + "\n```\n");
  const recovered = await searchTaskArchivePage(owner, text);

  assert.ok(recovered.results.length > 0);
  await writeFile(file, "# No retained records\n");
  const changed = await searchTaskArchivePage(owner, text);

  assert.deepEqual(changed.results, []);
  await rm(file);
  const deleted = await searchTaskArchivePage(owner, text);

  assert.deepEqual(deleted.results, []);
  const foreign = path.join(taskDirectory("isolated-parent"), "foreign.md");

  await writeTaskFile(taskDirectory("isolated-parent"), "foreign.md", "# foreignsecret\n");
  await symlink(foreign, path.join(directory, "foreign.md"));
  const foreignResults = await searchTaskArchivePage(owner, "foreignsecret");

  assert.deepEqual(foreignResults.results, []);
  await rm(path.join(directory, "foreign.md"));
  await checkStaleCandidate(owner);
}

/** Verify actual QMD subprocess retrieval, source fidelity, pagination and model-free recovery.
@param owner - Isolated parent whose ingestion/grouping workflow produced the archive.
@param taskName - Stable archive filename.
@param longOutput - Exact full tool output hidden by the timeline preview.
*/
export async function checkTaskSearch(owner: string, taskName: string, longOutput: string) {
  await settleTaskIndex(owner);
  const page = await searchTaskArchivePage(owner, "late-calendar-needle");
  const hit = page.results.at(0);

  assert.ok(hit);
  assert.equal(page.retrieval.engine, "@tobilu/qmd");
  assert.equal(page.retrieval.mode, "keyword");
  assert.equal(page.retrieval.reranked, false);
  assert.ok(page.retrieval.reasons.length > 0);
  assert.match(hit.excerpt, /late-calendar-needle/);
  const body = await readFile(hit.file, "utf8");

  assert.equal(body.slice(hit.passage.start, hit.passage.end), hit.excerpt);
  assert.equal(body.slice(0, hit.passage.start).split("\n").length, hit.passage.startLine);
  const source = contextEntrySchema.parse(JSON.parse(await readFile(hit.source.file, "utf8")));

  assert.equal(source.id, hit.source.id);
  assert.equal(source.text, longOutput);
  assert.match(JSON.stringify(source.original), /private-image-payload/);
  assert.ok(hit.passage.matchedTerms.includes("needle"));
  const first = await searchTaskArchivePage(owner, "retained output");

  assert.ok(first.pagination.nextOffset);
  const second = await searchTaskArchivePage(owner, "retained output", first.pagination.nextOffset);

  assert.ok(second.results.length > 0);
  assert.ok(second.results.every((result) => first.results.every((previous) => previous.file !== result.file)));

  for (const query of ["", "  ", "... !"]) {
    const empty = await searchTaskArchivePage(owner, query);

    assert.deepEqual(empty.results, []);
    assert.equal(empty.retrieval.mode, "keyword");
  }

  const isolated = await searchTaskArchivePage("isolated-parent", "late-calendar-needle");

  assert.deepEqual(isolated.results, []);
  await checkTaskMcp(owner);
  await checkReconciliation(owner, taskName);
}
