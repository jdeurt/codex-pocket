import { extractSnippet, type HybridQueryResult, type QMDStore } from "@tobilu/qmd";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { type TaskIndexDocument, isParentTaskFile, optionalTaskFile, taskViewHash } from "./task-index-views";

const RESULT_LIMIT = 5;
const CANDIDATE_LIMIT = 100;
const EXCERPT_LENGTH = 800;
const CONTEXT_LENGTH = 240;
const PASSAGE_CONTEXT = 120;

export interface RetrievalMode {
  engine: "@tobilu/qmd";
  mode: "keyword" | "hybrid";
  reranked: boolean;
  reasons: string[];
}

interface RankedDocument {
  file: string;
  score: number;
  chunkPos?: number;
  explain?: unknown;
}

/** Report the backends present in QMD's returned score traces.
@param results - Explained fused results.
@param retrieval - Mode to update when QMD produced no vector contribution.
*/
function reportRetrievalEvidence(results: HybridQueryResult[], retrieval: RetrievalMode) {
  if (!(
    retrieval.mode === "hybrid" &&
    results.length > 0 &&
    results.every((hit) => !hit.explain?.vectorScores.length)
  )) {
    return;
  }

  retrieval.mode = "keyword";
  retrieval.reasons.push(
    "QMD returned keyword contributions only for this query; no vector contribution was available."
  );
}

/** Use QMD's actual BM25 or fused lex/vector retrieval, without implicit query expansion/model downloads.
@param store - Private parent store with local-only model configuration.
@param query - User's literal query.
@param retrieval - Actual available capabilities; failures downgrade this object explicitly.
@returns QMD-ranked documents with engine scores and explanations.
*/
async function retrieve(store: QMDStore, query: string, retrieval: RetrievalMode): Promise<RankedDocument[]> {
  if (retrieval.mode === "hybrid" || retrieval.reranked) {
    const queries = [{ type: "lex" as const, query }];
    const expanded = retrieval.mode === "hybrid" ? [...queries, { type: "vec" as const, query }] : queries;

    try {
      const result = await store.search({
        queries: expanded,
        collections: ["tasks"],
        rerank: retrieval.reranked,
        explain: true,
        limit: CANDIDATE_LIMIT,
        candidateLimit: CANDIDATE_LIMIT,
        minScore: 0,
      });

      reportRetrievalEvidence(result, retrieval);

      return result.map((hit) => ({
        file: hit.file,
        score: hit.score,
        chunkPos: hit.bestChunkPos,
        explain: hit.explain,
      }));
    } catch (error) {
      retrieval.reasons.push(
        `Local model search unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
      retrieval.mode = "keyword";
      retrieval.reranked = false;
    }
  }

  const lexical = await store.searchLex(query, { collection: "tasks", limit: CANDIDATE_LIMIT });

  return lexical.map((hit) => ({
    file: hit.filepath,
    score: hit.score,
    explain: { backend: "QMD BM25", score: hit.score },
  }));
}

/** Select a passage from the actual indexed Markdown and expose exact line/character positions.
@param document - Current Markdown page and native source mapping.
@param query - Supplied query used by QMD's snippet selector.
@param chunkPos - QMD's best chunk position when vector/fused retrieval supplies one.
@returns Bounded excerpt, real offsets and honest literal match evidence.
*/
function passage(document: TaskIndexDocument, query: string, chunkPos?: number) {
  const snippet = extractSnippet(document.body, query, EXCERPT_LENGTH, chunkPos);
  const lines = document.body.split("\n");
  const selectedLine = Math.max(1, snippet.line);
  const lineStart = lines.slice(0, selectedLine - 1).reduce((length, line) => length + line.length + 1, 0);
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu))];
  const selected = (lines[selectedLine - 1] ?? "").toLowerCase();
  const positions = terms.map((term) => selected.indexOf(term)).filter((position) => position >= 0);
  const allPositions = terms
    .map((term) => document.body.toLowerCase().indexOf(term))
    .filter((position) => position >= 0);
  const fallback = allPositions.length > 0 ? Math.min(...allPositions) : lineStart;
  const match = positions.length > 0 ? lineStart + Math.min(...positions) : fallback;
  const start = Math.max(0, match - PASSAGE_CONTEXT);
  const text = document.body.slice(start, start + EXCERPT_LENGTH);
  const end = start + text.length;
  const startLine = document.body.slice(0, start).split("\n").length;

  return {
    text,
    start,
    end,
    startLine,
    endLine: startLine + text.split("\n").length - 1,
    offsetUnit: "UTF-16 code units in the Markdown file",
    omittedBefore: start,
    omittedAfter: document.body.length - end,
    matchedTerms: terms.filter((term) => text.toLowerCase().includes(term)),
  };
}

/** Reject stale, deleted or cross-parent documents before exposing indexed content or references.
@param owner - Authorized parent identity.
@param document - Candidate's current source mapping.
@returns Whether this evidence still agrees with the live task and local source files.
*/
async function isCurrentDocument(owner: string, document: TaskIndexDocument) {
  const valid = await Promise.all(
    [document.file, document.taskFile, document.sourceFile].map((file) => isParentTaskFile(owner, file))
  );

  if (valid.includes(false)) {
    return false;
  }

  const task = await optionalTaskFile(() => readFile(document.taskFile, "utf8"));
  const body = await optionalTaskFile(() => readFile(document.file, "utf8"));

  return task !== null && taskViewHash(task) === document.taskHash && body === document.body;
}

/** Search a reconciled parent index and map QMD evidence back to immutable native records.
@param store - Parent-only QMD index.
@param owner - Authorized parent identity.
@param documents - Reconciled readable Markdown pages.
@param query - Supplied query; whitespace/punctuation-only input returns an empty page.
@param offset - Number of validated ranked passages to skip.
@param retrieval - Actual local retrieval/rerank availability.
@returns Stable array entries plus page and reduced-mode information, including empty results.
*/
export async function searchTaskIndex(
  store: QMDStore,
  owner: string,
  documents: TaskIndexDocument[],
  query: string,
  offset: number,
  retrieval: RetrievalMode
) {
  const ranked = /[\p{L}\p{N}]/u.test(query) ? await retrieve(store, query, retrieval) : [];

  retrieval.reranked &&= ranked.length > 0;

  if (!/[\p{L}\p{N}]/u.test(query)) {
    retrieval.reasons.push("Empty or punctuation-only query; no retrieval was run.");
  }

  const candidates = [];

  for (const hit of ranked) {
    const document = documents.find((entry) => `qmd://tasks/${path.basename(entry.file)}` === hit.file);

    if (document && (await isCurrentDocument(owner, document))) {
      candidates.push({ document, hit });
    }
  }

  const ordered = candidates.toSorted(
    (a, b) => b.hit.score - a.hit.score || a.document.file.localeCompare(b.document.file)
  );
  const results = await Promise.all(
    ordered.slice(offset, offset + RESULT_LIMIT).map(async ({ document, hit }) => {
      const excerpt = passage(document, query, hit.chunkPos);
      const nearby = documents.filter(
        (entry) => entry.taskFile === document.taskFile && Math.abs(entry.sequence - document.sequence) === 1
      );
      const neighbors = new Map(nearby.toReversed().map((entry) => [entry.sequence, entry]))
        .values()
        .toArray()
        .toSorted((a, b) => a.sequence - b.sequence);
      const context = [];

      for (const entry of neighbors) {
        if (await isCurrentDocument(owner, entry)) {
          context.push({
            sourceId: entry.sourceId,
            sequence: entry.sequence,
            file: entry.file,
            excerpt: entry.text.slice(0, CONTEXT_LENGTH),
            truncated: entry.text.length > CONTEXT_LENGTH,
          });
        }
      }

      return {
        file: document.file,
        taskFile: document.taskFile,
        score: hit.score,
        excerpt: excerpt.text,
        passage: excerpt,
        context,
        source: {
          id: document.sourceId,
          sequence: document.sequence,
          file: document.sourceFile,
          timestamp: document.timestamp,
        },
        ranking: hit.explain,
        retrieval,
      };
    })
  );

  return {
    results,
    retrieval,
    pagination: {
      offset,
      limit: RESULT_LIMIT,
      candidateLimit: CANDIDATE_LIMIT,
      totalCandidates: ordered.length,
      nextOffset: offset + RESULT_LIMIT < ordered.length ? offset + RESULT_LIMIT : null,
      candidateWindowFull: ranked.length === CANDIDATE_LIMIT,
    },
  };
}
