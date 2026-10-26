import { createHash } from "node:crypto";
import { readdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { taskDirectory } from "../archive";
import { regenerateTaskProjections, writeProjection } from "../projections";
import { sourceTaskAssociations } from "../projection-model";
import { taskTimeline } from "../render";
import { canonicalTaskSources, type IndexedSource } from "./records";
import { taskIndexDirectory } from "./paths";
import { type TaskIndexDocument, taskPages, documentFilename } from "./documents";

export { isParentTaskFile, taskIndexDirectory } from "./paths";
export type { TaskIndexDocument } from "./documents";

/** Hash exact navigation bytes so stale search references can be rejected.
@param content - Actual projection contents.
@returns Projection identity.
*/
export function taskViewHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

/** Select an original source for an explicitly surrounding chronological view.
@param source - Canonical original.
@returns Exact source entry.
*/
function sourceEntry(source: IndexedSource) {
  return source.entry;
}

/** Reconcile source passages once, returning current task associations independently of page identity.
@param owner - Parent whose files are the only input.
@returns Source-validated searchable pages.
*/
export async function reconcileTaskViews(owner: string) {
  const root = taskDirectory(owner);
  const index = await taskIndexDirectory(owner);
  const directory = path.join(index, "views");
  const { state, taskFiles } = await regenerateTaskProjections(owner);
  const sources = await canonicalTaskSources(owner);
  const chronology = path.join(root, "chronology.md");

  const records = new Map();

  for (const source of sources) {
    records.set(source.entry, source.sourceFile);
  }

  await writeProjection(
    root,
    "chronology.md",
    `# Chronological context\n\nLedger revision: ${String(state.revision)}\n\n` +
      "Chronology is preserved within each source namespace; imported history precedes the native session. Chronological proximity does not establish task membership. Follow exact source references for evidence.\n\n" +
      taskTimeline(Array.from(sources, sourceEntry), { records })
  );
  const documents: TaskIndexDocument[] = [];

  for (const source of sources) {
    const taskAssociations = source.namespace === "native" ? sourceTaskAssociations(state, source.entry.id) : [];
    const firstTask = taskAssociations[0]?.taskId;
    const primary = firstTask ? taskFiles.get(firstTask) : undefined;
    const taskFile = primary ?? (state.mode === "live" ? chronology : source.fallbackTaskFile);
    const taskHash = taskViewHash(await readFile(taskFile, "utf8"));
    const pages = taskPages(`source-${source.key}`, taskFile, source.sourceFile, source.entry);

    for (const page of pages) {
      await writeProjection(directory, page.name, page.body);
      documents.push({
        file: path.join(directory, page.name),
        taskFile,
        taskHash,
        sourceFile: source.sourceFile,
        sourceId: source.entry.id,
        sourceNamespace: source.namespace,
        sequence: source.entry.sequence,
        timestamp: page.timestamp,
        body: page.body,
        text: page.text,
        taskAssociations,
      });
    }
  }

  const current = new Set(Array.from(documents, documentFilename));
  const indexedNames = await readdir(directory);

  for (const name of indexedNames) {
    if (name.endsWith(".md") && !current.has(name)) {
      await rm(path.join(directory, name));
    }
  }

  return documents;
}
