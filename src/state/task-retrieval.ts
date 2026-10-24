import { type HybridQueryResult } from "@tobilu/qmd";

export interface RetrievalMode {
  engine: "@tobilu/qmd";
  mode: "keyword" | "hybrid";
  reranked: boolean;
  reasons: string[];
}
export interface RankedDocument {
  file: string;
  score: number;
  chunkPos?: number;
  explain?: unknown;
}

/** Record an explicit fallback without changing the previous capability state.
@param retrieval - Previous capabilities.
@param reason - Actual fallback reason.
@param shouldDisableReranking - Whether model reranking is unavailable too.
@returns Keyword capabilities with the full prior reason history.
*/
export function keywordRetrieval(
  retrieval: RetrievalMode,
  reason: string,
  shouldDisableReranking = false
): RetrievalMode {
  return {
    ...retrieval,
    mode: "keyword",
    reranked: !shouldDisableReranking && retrieval.reranked,
    reasons: [...retrieval.reasons, reason],
  };
}

/** Describe installed capabilities from explicit validated model availability.
@param hasEmbedding - Whether a local embedding model exists.
@param hasReranking - Whether a local reranking model exists.
@returns Initial truthful retrieval state.
*/
export function retrievalCapabilities(hasEmbedding: boolean, hasReranking: boolean): RetrievalMode {
  const reasons: string[] = [];

  if (!hasEmbedding) {
    reasons.push("Local embedding model unavailable; using QMD BM25 keyword retrieval.");
  }

  if (!hasReranking) {
    reasons.push("Local reranking model unavailable; model reranking disabled.");
  }

  return { engine: "@tobilu/qmd", mode: hasEmbedding ? "hybrid" : "keyword", reranked: hasReranking, reasons };
}

/** Describe actual vector participation in returned QMD evidence.
@param results - Engine explanations.
@param retrieval - Available capabilities before this query.
@returns Capabilities reflecting the actual returned evidence.
*/
export function retrievalEvidence(results: readonly HybridQueryResult[], retrieval: RetrievalMode): RetrievalMode {
  if (retrieval.mode !== "hybrid" || results.length === 0) {
    return retrieval;
  }

  for (const hit of results) {
    if (hit.explain?.vectorScores.length) {
      return retrieval;
    }
  }

  return keywordRetrieval(
    retrieval,
    "QMD returned keyword contributions only for this query; no vector contribution was available."
  );
}

/** Record whether retrieval and reranking actually produced candidates.
@param retrieval - Capabilities after engine execution.
@param count - Actual ranked candidate count.
@param hasQuery - Whether literal searchable input was supplied.
@returns Honest query completion state.
*/
export function completedRetrieval(retrieval: RetrievalMode, count: number, hasQuery: boolean): RetrievalMode {
  return {
    ...retrieval,
    reranked: retrieval.reranked && count > 0,
    reasons: hasQuery
      ? retrieval.reasons
      : [...retrieval.reasons, "Empty or punctuation-only query; no retrieval was run."],
  };
}

/** Preserve engine ranking fields without exposing mutable native results.
@param hit - Native QMD result.
@returns Detached canonical ranking evidence.
*/
export function rankedHybridDocument(hit: HybridQueryResult): RankedDocument {
  return { file: hit.file, score: hit.score, chunkPos: hit.bestChunkPos, explain: hit.explain };
}

/** Describe a keyword engine result using its explicit score.
@param hit - Native keyword result.
@returns Detached keyword ranking evidence.
*/
export function rankedLexicalDocument(hit: { filepath: string; score: number }): RankedDocument {
  return { file: hit.filepath, score: hit.score, explain: { backend: "QMD BM25", score: hit.score } };
}
