import { optionalFile, fileText, canonicalPath } from "./optional-file";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { localDirectory } from "./local-state";
import { readTaskArchive } from "./task-archive-read";
import { contextEntrySchema, type ContextEntry, taskDirectory, writeTaskFile } from "./task-archive";

import { type TaskIndexDocument, taskPages, markdownNames, documentFilename } from "../state/task-documents";

export type { TaskIndexDocument } from "../state/task-documents";

/** Hash the current reading view to reject stale search evidence after concurrent archive changes.
@param content - Exact view contents.
@returns Deterministic content identity.
*/
export function taskViewHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

/** Check a source path belongs to this exact parent and is not a symlink into another namespace.
@param owner - Authorized parent identity.
@param file - Existing archive, detail view or source path.
@returns Whether the file is a regular, unredirected descendant of the parent directory.
*/
export async function isParentTaskFile(owner: string, file: string) {
  const root = taskDirectory(owner);

  if (!file.startsWith(root + path.sep)) {
    return false;
  }

  const stateRoot = await optionalFile(canonicalPath, localDirectory());
  const expected = stateRoot ? path.join(stateRoot, path.relative(localDirectory(), file)) : null;
  const resolved = await optionalFile(canonicalPath, file);
  const info = await optionalFile(stat, file);

  return resolved === expected && info?.isFile() === true;
}

/** Create index directories only inside the canonical parent namespace, rejecting redirected index files.
@param owner - Authorized parent identity.
@returns Verified private index directory.
*/
export async function taskIndexDirectory(owner: string) {
  const root = taskDirectory(owner);

  await mkdir(localDirectory(), { recursive: true, mode: 0o700 });
  const stateRoot = await realpath(localDirectory());
  const directories = [
    path.join(localDirectory(), "tasks"),
    root,
    path.join(root, "qmd"),
    path.join(root, "qmd", "views"),
  ];

  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });

    if ((await realpath(directory)) !== path.join(stateRoot, path.relative(localDirectory(), directory))) {
      throw new Error("Task index directory redirects outside its parent namespace.");
    }
  }

  const index = path.join(root, "qmd");

  for (const name of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"]) {
    const info = await optionalFile(lstat, path.join(index, name));

    if (info?.isSymbolicLink()) {
      throw new Error("Task index database redirects outside its parent namespace.");
    }
  }

  return index;
}

/** Persist a readable detail page only when its contents changed, retaining QMD's incremental update signal.
@param directory - Private Markdown collection directory.
@param name - Host-generated filename.
@param body - Full page text.
*/
async function writeChanged(directory: string, name: string, body: string) {
  const file = path.join(directory, name);
  const info = await optionalFile(lstat, file);

  if (info?.isSymbolicLink()) {
    await writeTaskFile(directory, name, body);

    return;
  }

  const previous = await optionalFile(fileText, file);

  if (previous !== body) {
    await writeTaskFile(directory, name, body);
  }
}

/** Resolve a per-record source only when its exact content agrees with this archive envelope.
@param owner - Parent namespace.
@param entry - Exact retained archive entry.
@param fallback - Existing full envelope for older/imported records.
@returns A verified immutable record path or the exact retained envelope.
*/
async function exactSourceFile(owner: string, entry: ContextEntry, fallback: string) {
  const file = path.join(taskDirectory(owner), "source", `${String(entry.sequence)}.json`);

  if (!(await isParentTaskFile(owner, file))) {
    return fallback;
  }

  const content = await optionalFile(fileText, file);

  if (content === null) {
    return fallback;
  }

  const source = contextEntrySchema.parse(JSON.parse(content));

  return JSON.stringify(source) === JSON.stringify(entry) ? file : fallback;
}

/** Materialize searchable Markdown detail pages from exact records, keeping the main timeline compact.
@param owner - Authorized parent.
@param taskFile - Existing task view, including old-format archives.
@param directory - QMD's private collection directory.
@returns Current pages and their exact source mapping.
*/
async function taskDocuments(owner: string, taskFile: string, directory: string) {
  if (!(await isParentTaskFile(owner, taskFile))) {
    return [];
  }

  const taskHash = taskViewHash(await readFile(taskFile, "utf8"));
  const rawFile = taskFile.replace(/\.md$/u, ".json");
  const rawExists = await optionalFile(stat, rawFile);

  if (rawExists && !(await isParentTaskFile(owner, rawFile))) {
    return [];
  }

  const archive = await readTaskArchive(taskFile);

  if (!(await isParentTaskFile(owner, archive.rawFile))) {
    return [];
  }

  const documents: TaskIndexDocument[] = [];
  const taskName = path.basename(taskFile, ".md");

  for (const entry of archive.entries) {
    const sourceFile = await exactSourceFile(owner, entry, archive.rawFile);
    const pages = taskPages(taskName, taskFile, sourceFile, entry);

    for (const page of pages) {
      await writeChanged(directory, page.name, page.body);
      documents.push({
        file: path.join(directory, page.name),
        taskFile,
        taskHash,
        sourceFile,
        sourceId: entry.id,
        sequence: entry.sequence,
        timestamp: page.timestamp,
        body: page.body,
        text: page.text,
      });
    }
  }

  return documents;
}

/** Reconcile all views, including changed/deleted tasks and missed writes after a process restart.
@param owner - Parent whose files are the only index input.
@returns Current readable documents with verified source references.
*/
export async function reconcileTaskViews(owner: string) {
  const root = taskDirectory(owner);
  const index = await taskIndexDirectory(owner);
  const directory = path.join(index, "views");
  const files = await readdir(root);
  const names = markdownNames(files);
  const documents: TaskIndexDocument[] = [];

  for (const name of names) {
    documents.push(...(await taskDocuments(owner, path.join(root, name), directory)));
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
