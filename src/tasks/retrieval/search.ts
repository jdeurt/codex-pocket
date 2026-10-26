import { passage } from "./passage";
import { optionalFile, fileText } from "../../server/optional-file";
import { type QMDStore } from "@tobilu/qmd";
import path from "node:path";
import { type TaskIndexDocument, isParentTaskFile, taskViewHash } from "./views";
import { t as attempt } from "try";

const RESULT_LIMIT = 5;
const CANDIDATE_LIMIT = 100;
const CONTEXT_LENGTH = 240;

import {
  type RetrievalMode,
  type RankedDocument,
  keywordRetrieval,
  retrievalEvidence,
  completedRetrieval,
  rankedHybridDocument,
  rankedLexicalDocument,
} from "./model";

export type { RetrievalMode } from "./model";

/** Execute a native QMD model search with explicit capabilities.
@param store - Parent-only native index.
@param query - Literal user query.
@param retrieval - Available local capabilities.
@returns Native explained engine results.
*/
function searchModels(store: QMDStore, query: string, retrieval: RetrievalMode) {
  const queries = [{ type: "lex" as const, query }];
  const expanded = retrieval.mode === "hybrid" ? [...queries, { type: "vec" as const, query }] : queries;

  return store.search({
    queries: expanded,
    collections: ["tasks"],
    rerank: retrieval.reranked,
    explain: true,
    limit: CANDIDATE_LIMIT,
    candidateLimit: CANDIDATE_LIMIT,
    minScore: 0,
  });
}

/** Use QMD's actual BM25 or fused lex/vector retrieval, without implicit query expansion/model downloads.
@param store - Private parent store with local-only model configuration.
@param query - User's literal query.
@param retrieval - Actual available capabilities, left unchanged.
@returns QMD-ranked documents with engine scores and explanations.
*/
async function retrieve(store: QMDStore, query: string, retrieval: RetrievalMode) {
  let mode = retrieval;

  if (retrieval.mode === "hybrid" || retrieval.reranked) {
    const result = await attempt(searchModels, store, query, retrieval);

    if (result.ok) {
      return {
        ranked: Array.from(result.value, rankedHybridDocument),
        retrieval: retrievalEvidence(result.value, retrieval),
      };
    }

    const error = result.error;

    mode = keywordRetrieval(
      retrieval,
      `Local model search unavailable: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }

  const lexical = await store.searchLex(query, { collection: "tasks", limit: CANDIDATE_LIMIT });

  return { ranked: Array.from(lexical, rankedLexicalDocument), retrieval: mode };
}

/** Reject stale, deleted or cross-parent documents before exposing indexed content or references.
@param owner - Authorized parent identity.
@param document - Candidate's current source mapping.
@returns Whether this evidence still agrees with the live task and local source files.
*/
async function isCurrentDocument(owner: string, document: TaskIndexDocument) {
  const valid = await Promise.all(
    Array.from([document.file, document.taskFile, document.sourceFile], isParentTaskFile.bind(undefined, owner))
  );

  if (valid.includes(false)) {
    return false;
  }

  const task = await optionalFile(fileText, document.taskFile);
  const body = await optionalFile(fileText, document.file);

  return task !== null && taskViewHash(task) === document.taskHash && body === document.body;
}

interface Candidate {
  document: TaskIndexDocument;
  hit: RankedDocument;
}

/** Resolve an engine identity against the explicitly reconciled documents.
@param documents - Authorized parent documents.
@param file - Engine result identity.
@returns Matching current document.
*/
function findDocument(documents: readonly TaskIndexDocument[], file: string) {
  for (const document of documents) {
    if (`qmd://tasks/${path.basename(document.file)}` === file) {
      return document;
    }
  }
}

/** Order validated results by engine score then stable source path.
@param first - First candidate.
@param second - Second candidate.
@returns Stable ranking order.
*/
function compareCandidates(first: Candidate, second: Candidate) {
  return second.hit.score - first.hit.score || first.document.file.localeCompare(second.document.file);
}

/** Order adjacent source evidence in its canonical sequence.
@param first - First document.
@param second - Second document.
@returns Source sequence order.
*/
function compareSequence(first: TaskIndexDocument, second: TaskIndexDocument) {
  return first.sequence - second.sequence;
}

/** Select adjacent records, retaining the first page of each source sequence.
@param documents - Reconciled source pages.
@param document - Selected search hit.
@returns Adjacent source records in native order.
*/
function neighboringDocuments(documents: readonly TaskIndexDocument[], document: TaskIndexDocument) {
  const neighbors = new Map<number, TaskIndexDocument>();

  for (const entry of documents) {
    if (
      entry.sourceNamespace === document.sourceNamespace &&
      entry.taskFile === document.taskFile &&
      Math.abs(entry.sequence - document.sequence) === 1 &&
      !neighbors.has(entry.sequence)
    ) {
      neighbors.set(entry.sequence, entry);
    }
  }

  return neighbors.values().toArray().toSorted(compareSequence);
}

/** Validate neighboring evidence and assemble one readable search result.
@param owner - Authorized parent.
@param documents - Reconciled readable pages.
@param query - Literal query.
@param retrieval - Actual completed capabilities.
@param candidate - Validated ranked hit.
@returns Readable result with exact source positions.
*/
async function searchResult(
  owner: string,
  documents: TaskIndexDocument[],
  query: string,
  retrieval: RetrievalMode,
  candidate: Candidate
) {
  const { document, hit } = candidate;
  const excerpt = passage(document, query, hit.chunkPos);
  const context = [];

  for (const entry of neighboringDocuments(documents, document)) {
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
    taskAssociations: document.taskAssociations,
    score: hit.score,
    excerpt: excerpt.text,
    passage: excerpt,
    context,
    source: {
      id: document.sourceId,
      namespace: document.sourceNamespace,
      sequence: document.sequence,
      file: document.sourceFile,
      timestamp: document.timestamp,
    },
    ranking: hit.explain,
    retrieval,
  };
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
  const hasQuery = /[\p{L}\p{N}]/u.test(query);
  const search = hasQuery ? await retrieve(store, query, retrieval) : { ranked: [], retrieval };
  const ranked = search.ranked;
  const mode = completedRetrieval(search.retrieval, ranked.length, hasQuery);

  const candidates = [];

  for (const hit of ranked) {
    const document = findDocument(documents, hit.file);

    if (document && (await isCurrentDocument(owner, document))) {
      candidates.push({ document, hit });
    }
  }

  const ordered = candidates.toSorted(compareCandidates);
  const results = await Promise.all(
    Array.from(
      ordered.slice(offset, offset + RESULT_LIMIT),
      searchResult.bind(undefined, owner, documents, query, mode)
    )
  );

  return {
    results,
    retrieval: mode,
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
