import { extractSnippet } from "@tobilu/qmd";
import { type TaskIndexDocument } from "./documents";

const NOT_FOUND = -1;
const EXCERPT_LENGTH = 800;
const PASSAGE_CONTEXT = 120;

/** Select a passage from the actual indexed Markdown and expose exact line/character positions.
@param document - Current Markdown page and native source mapping.
@param query - Supplied query used by QMD's snippet selector.
@param chunkPos - QMD's best chunk position when vector/fused retrieval supplies one.
@returns Bounded excerpt, real offsets and honest literal match evidence.
*/
export function passage(document: TaskIndexDocument, query: string, chunkPos?: number) {
  const snippet = extractSnippet(document.body, query, EXCERPT_LENGTH, chunkPos);
  const lines = document.body.split("\n");
  const selectedLine = Math.max(1, snippet.line);

  let lineStart = 0;

  for (let index = 0; index < selectedLine - 1; index++) {
    lineStart += lines[index].length + 1;
  }

  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu))];
  const selected = (lines[selectedLine - 1] ?? "").toLowerCase();
  const positions: number[] = [];
  const allPositions: number[] = [];
  const lowerBody = document.body.toLowerCase();

  for (const term of terms) {
    const position = selected.indexOf(term);
    const bodyPosition = lowerBody.indexOf(term);

    if (position !== NOT_FOUND) {
      positions.push(position);
    }

    if (bodyPosition !== NOT_FOUND) {
      allPositions.push(bodyPosition);
    }
  }

  const fallback = allPositions.length > 0 ? Math.min(...allPositions) : lineStart;
  const match = positions.length > 0 ? lineStart + Math.min(...positions) : fallback;
  const start = Math.max(0, match - PASSAGE_CONTEXT);
  const text = document.body.slice(start, start + EXCERPT_LENGTH);
  const end = start + text.length;
  const startLine = document.body.slice(0, start).split("\n").length;

  const matchedTerms: string[] = [];

  for (const term of terms) {
    if (text.toLowerCase().includes(term)) {
      matchedTerms.push(term);
    }
  }

  return {
    text,
    start,
    end,
    startLine,
    endLine: startLine + text.split("\n").length - 1,
    offsetUnit: "UTF-16 code units in the Markdown file",
    omittedBefore: start,
    omittedAfter: document.body.length - end,
    matchedTerms,
  };
}
