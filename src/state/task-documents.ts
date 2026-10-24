import path from "node:path";
import { type ContextEntry } from "./task-archive";
import { recordView, sourceLink, type RecordPart, indentedSourceLine } from "./task-record";

const PAGE_LENGTH = 6000;
const PAGE_OVERLAP = 300;
const PAGE_STRIDE = PAGE_LENGTH - PAGE_OVERLAP;

export interface TaskIndexDocument {
  file: string;
  taskFile: string;
  taskHash: string;
  sourceFile: string;
  sourceId: string;
  sequence: number;
  timestamp: string | null;
  body: string;
  text: string;
}

/** Format one readable native content part.
@param part - Explicit native content projection.
@returns Searchable labeled content.
*/
function partText(part: RecordPart) {
  return `${part.label}${part.callId ? ` · Call ID: ${part.callId}` : ""}\n${part.text}`;
}

/** Construct bounded readable pages from explicit native source content.
@param taskName - Stable task filename stem.
@param taskFile - Authorized timeline file.
@param sourceFile - Authorized exact source file.
@param entry - Immutable native source entry.
@returns Markdown pages and exact source text ranges.
*/
export function taskPages(taskName: string, taskFile: string, sourceFile: string, entry: ContextEntry) {
  const view = recordView(entry);
  const text = Array.from(view.parts, partText).join("\n\n");
  const count = Math.max(1, Math.ceil(text.length / PAGE_STRIDE));
  const pages = [];

  for (let page = 0; page < count; page++) {
    const content = text.slice(page * PAGE_STRIDE, page * PAGE_STRIDE + PAGE_LENGTH);
    const body = [
      `# Task ${taskName} · Source ${String(entry.sequence)} · Page ${String(page + 1)}/${String(count)}`,
      "",
      `Source ID: ${JSON.stringify(entry.id)} · Role: ${entry.role} · Timestamp: ${view.timestamp ?? "not recorded"}`,
      `[Task timeline](${sourceLink(taskFile)}) · [Exact original record](${sourceLink(sourceFile)})`,
      "",
      `Text range: ${String(page * PAGE_STRIDE)}–${String(Math.min(text.length, page * PAGE_STRIDE + PAGE_LENGTH))} ` +
        `of ${String(text.length)} UTF-16 code units. Non-text fields remain in the original record.`,
      "",
      ...Array.from(content.split("\n"), indentedSourceLine),
      "",
    ].join("\n");

    pages.push({
      name: `${taskName}-${String(entry.sequence)}-${String(page)}.md`,
      body,
      text: content,
      timestamp: view.timestamp,
    });
  }

  return pages;
}

/** Order filenames deterministically for reconciliation.
@param first - First filename.
@param second - Second filename.
@returns Stable filename order.
*/
function compareNames(first: string, second: string) {
  return first.localeCompare(second);
}

/** Select readable task views from explicit directory entries.
@param names - Native directory entries.
@returns Ordered Markdown filenames.
*/
export function markdownNames(names: readonly string[]) {
  const selected: string[] = [];

  for (const name of names) {
    if (name.endsWith(".md")) {
      selected.push(name);
    }
  }

  return selected.toSorted(compareNames);
}

/** Select a document's managed filename.
@param document - Current source mapping.
@returns Filename used for reconciliation.
*/
export function documentFilename(document: TaskIndexDocument) {
  return path.basename(document.file);
}
