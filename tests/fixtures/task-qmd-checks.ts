import assert from "node:assert/strict";
import { mock } from "node:test";
import { type QMDStore } from "@tobilu/qmd";
import { type TaskIndexDocument } from "../../src/server/task-index-views";
import { searchTaskIndex } from "../../src/server/task-index-search";

/** Supply deterministic local-model outputs while exercising real QMD embedding storage and vector retrieval.
@param text - QMD's formatted query or document chunk.
@returns A small normalized fixture embedding; no model download or provider call occurs.
*/
function fixtureEmbedding(text: string) {
  return { embedding: /calendar|appointment/iu.test(text) ? [1, 0] : [0, 1], model: "offline-workflow" };
}

/** Exercise real QMD storage and retrieval with controlled offline inference outputs.
@param store - Private QMD index.
@param owner - Parent identity.
@param documents - Source-backed Markdown pages.
@param failEmbedding - Switch the fixture inference boundary to a runtime failure.
*/
async function exerciseHybrid(
  store: QMDStore,
  owner: string,
  documents: TaskIndexDocument[],
  failEmbedding: () => void
) {
  const llm = store.internal.llm;

  assert.ok(llm);
  store.internal.ensureVecTable(2);
  const indexed = await store.searchLex("Source", { limit: documents.length });

  for (const entry of indexed) {
    store.internal.insertEmbedding(
      entry.hash,
      0,
      0,
      new Float32Array(fixtureEmbedding(entry.body ?? "").embedding),
      llm.embedModelName,
      new Date().toISOString()
    );
  }

  assert.ok(indexed.length > 0);
  const lexical = await store.searchLex("appointment");

  assert.deepEqual(lexical, []);
  const hybrid = await searchTaskIndex(store, owner, documents, "appointment", 0, {
    engine: "@tobilu/qmd",
    mode: "hybrid",
    reranked: true,
    reasons: [],
  });
  const best = hybrid.results.at(0);

  assert.ok(best);
  assert.deepEqual(best.passage.matchedTerms, []);
  assert.equal(hybrid.retrieval.mode, "hybrid");
  assert.equal(hybrid.retrieval.reranked, true);
  assert.match(JSON.stringify(best.ranking), /vectorScores/);
  failEmbedding();
  const fallback = await searchTaskIndex(store, owner, documents, "late-calendar-needle", 0, {
    engine: "@tobilu/qmd",
    mode: "hybrid",
    reranked: true,
    reasons: [],
  });

  assert.equal(fallback.retrieval.mode, "keyword");
  assert.equal(fallback.retrieval.reranked, false);
  assert.match(fallback.retrieval.reasons.join(" "), /Local embedding runtime unavailable/);
  assert.ok(fallback.results.length > 0);
}

/** Exercise QMD's vector index/fusion, local reranking and model-failure fallback with offline inference only.
@param store - Real private QMD SQLite store.
@param owner - Parent identity.
@param documents - Actual readable archive pages.
*/
export async function checkQmdHybrid(store: QMDStore, owner: string, documents: TaskIndexDocument[]) {
  const llm = store.internal.llm;

  assert.ok(llm);

  const batch = mock.method(llm, "embedBatch", (texts: string[]) =>
    Promise.resolve(texts.map((text) => fixtureEmbedding(text)))
  );
  const rerank = mock.method(llm, "rerank", (_query: string, items: { file: string; text: string }[]) =>
    Promise.resolve({
      results: items.map((item, index) => ({ file: item.file, score: 1 / (index + 1), index })),
      model: "offline-workflow",
    })
  );

  try {
    await exerciseHybrid(store, owner, documents, () => {
      batch.mock.mockImplementation(() => {
        throw new Error("Local embedding runtime unavailable");
      });
    });
    assert.ok(rerank.mock.calls.length > 0);
  } finally {
    batch.mock.restore();
    rerank.mock.restore();
  }
}
