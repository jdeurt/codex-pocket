import { object } from "../../lib/protocol";
import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { optionalFile, directoryNames } from "../../server/optional-file";
import { readTaskArchive } from "../adapters/legacy-read";
import { taskDirectory, contextEntrySchema, type ContextEntry } from "../archive";
import { readTaskSources } from "../sources";
import { isParentTaskFile } from "./paths";
import { markdownNames } from "./documents";

const BEFORE = -1;

export interface IndexedSource {
  key: string;
  namespace: "codex" | "native";
  entry: ContextEntry;
  sourceFile: string;
  fallbackTaskFile: string;
}

/** Give one exact source passage a stable index identity independent of task membership.
@param entry - Exact original source.
@returns Content-verified source identity.
*/
function sourceKey(entry: ContextEntry) {
  return createHash("sha256")
    .update(JSON.stringify({ id: entry.id, role: entry.role, text: entry.text, original: entry.original }))
    .digest("hex");
}

/** Keep imported history separate from the native session's source sequence.
@param entry - Exact original source.
@returns Recorded source namespace.
*/
function sourceNamespace(entry: ContextEntry): IndexedSource["namespace"] {
  return object(entry.original).source === "codex" ? "codex" : "native";
}

/** Order records within their original namespace without using task filenames as chronology.
@param first - First canonical source.
@param second - Second canonical source.
@returns Imported history before native records, then recorded source sequence.
*/
function compareSources(first: IndexedSource, second: IndexedSource) {
  if (first.namespace !== second.namespace) {
    return first.namespace === "codex" ? BEFORE : 1;
  }

  return first.entry.sequence - second.entry.sequence || first.key.localeCompare(second.key, "en");
}

/** Resolve a canonical native record only when it agrees exactly with its legacy envelope.
@param owner - Authorized parent.
@param entry - Retained source.
@param fallback - Validated original envelope.
@returns Actual original record or preserved legacy envelope reference.
*/
async function exactSourceFile(owner: string, entry: ContextEntry, fallback: string) {
  const file = path.join(taskDirectory(owner), "source", `${String(entry.sequence)}.json`);

  if (!(await isParentTaskFile(owner, file))) {
    return fallback;
  }

  const source = contextEntrySchema.parse(JSON.parse(await readFile(file, "utf8")));

  return JSON.stringify(source) === JSON.stringify(entry) ? file : fallback;
}

/** Collect exact sources from validated legacy envelopes without indexing surrounding context per task.
@param owner - Authorized parent.
@param taskFile - Existing legacy navigation file.
@returns Exact source identities and provenance references.
*/
async function legacySources(owner: string, taskFile: string): Promise<IndexedSource[]> {
  if (!(await isParentTaskFile(owner, taskFile))) {
    return [];
  }

  const rawFile = taskFile.replace(/\.md$/u, ".json");
  const raw = await optionalFile(stat, rawFile);

  if (raw && !(await isParentTaskFile(owner, rawFile))) {
    return [];
  }

  const archive = await readTaskArchive(taskFile);

  if (!(await isParentTaskFile(owner, archive.rawFile))) {
    return [];
  }

  const sources: IndexedSource[] = [];

  for (const entry of archive.entries) {
    sources.push({
      key: sourceKey(entry),
      namespace: sourceNamespace(entry),
      entry,
      sourceFile: await exactSourceFile(owner, entry, archive.rawFile),
      fallbackTaskFile: taskFile,
    });
  }

  return sources;
}

/** Deduplicate original source passages before generating any searchable representation.
@param owner - Authorized parent.
@returns Each exact original once, with chronological fallback navigation.
*/
export async function canonicalTaskSources(owner: string) {
  const root = taskDirectory(owner);
  const names = markdownNames((await optionalFile(directoryNames, root)) ?? []);
  const sources = new Map<string, IndexedSource>();

  for (const name of names) {
    if (name === "chronology.md" || name.startsWith("task-")) {
      continue;
    }

    const originals = await legacySources(owner, path.join(root, name));

    for (const original of originals) {
      if (!sources.has(original.key)) {
        sources.set(original.key, original);
      }
    }
  }

  const native = await readTaskSources(owner);

  for (const source of native) {
    const key = sourceKey(source.entry);

    sources.set(key, {
      key,
      namespace: sourceNamespace(source.entry),
      entry: source.entry,
      sourceFile: source.file,
      fallbackTaskFile: sources.get(key)?.fallbackTaskFile ?? path.join(root, "chronology.md"),
    });
  }

  return sources.values().toArray().toSorted(compareSources);
}
