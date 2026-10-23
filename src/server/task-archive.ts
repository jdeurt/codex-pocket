import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { localDirectory } from "./local-state";
import path from "node:path";
import { z } from "zod";

const LAST_ENTRY = -1;
const EXCERPT_LENGTH = 800;
const SEARCH_LIMIT = 5;

export const contextEntrySchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  role: z.string(),
  text: z.string(),
  original: z.unknown(),
});

export type ContextEntry = z.infer<typeof contextEntrySchema>;
export const activeMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  entries: z.array(contextEntrySchema),
});

export type ActiveMessage = z.infer<typeof activeMessageSchema>;
export const taskGroupSchema = z.object({
  id: z.uuid(),
  file: z.string(),
  anchor: z.string(),
  matched: z.array(z.string()),
});

export type TaskGroup = z.infer<typeof taskGroupSchema>;

/** Keep each parent's archive in a private namespace without interpreting thread IDs as paths.
@param owner - Durable Pocket parent identity.
@returns Private directory containing Markdown contexts and active state.
*/
export function taskDirectory(owner: string) {
  return path.join(localDirectory(), "tasks", createHash("sha256").update(owner).digest("hex"));
}

/** Atomically replace a private task file without truncating its last successful version.
@param directory - Private parent namespace.
@param name - Host-generated basename, never user input.
@param content - Exact serialized file content.
*/
export async function writeTaskFile(directory: string, name: string, content: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, name);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;

  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, destination);
}

/** Persist exact source records independently of task membership for interleaved archival envelopes.
@param owner - Parent identity.
@param entry - Monotonic source record, written before advancing active state.
@returns Completion after the source record is durable.
*/
export function saveTaskSource(owner: string, entry: ContextEntry) {
  return writeTaskFile(
    path.join(taskDirectory(owner), "source"),
    `${String(entry.sequence)}.json`,
    JSON.stringify(entry)
  );
}

/** Read the original source interval without consulting historical task membership.
@param owner - Parent identity.
@param entries - Retained active entries establishing the archival interval.
@returns Exact ordered source records, including interleaved records removed from active membership.
*/
async function sourceEnvelope(owner: string, entries: ContextEntry[]) {
  const first = entries[0]?.sequence ?? 0;
  const last = entries.at(LAST_ENTRY)?.sequence ?? first;
  const envelope: ContextEntry[] = [];

  for (let sequence = first; sequence <= last; sequence++) {
    const file = path.join(taskDirectory(owner), "source", `${String(sequence)}.json`);
    const content = await readFile(file, "utf8");

    envelope.push(contextEntrySchema.parse(JSON.parse(content)));
  }

  return envelope;
}

/** Write exact source records with explicit membership and chronological interleaving provenance.
@param owner - Owning parent identity.
@param group - Stable open-task identity and filename.
@param matched - User messages assigned to this task.
@param working - Active messages, including interleaved task context.
@param isClosed - Whether five consecutive nonmatches closed this group.
*/
export async function archiveTask(
  owner: string,
  group: TaskGroup,
  matched: ActiveMessage[],
  working: ActiveMessage[],
  isClosed: boolean
) {
  const first = working.findIndex((message) => message.id === group.anchor);
  // Retain the examined interleaving envelope, including results after another user steered the run.
  // Context is deliberately duplicated across files; membership remains explicit in metadata.
  const activeEntries = working.slice(first).flatMap((message) => message.entries);
  const entries = await sourceEnvelope(owner, activeEntries);
  const metadata = {
    ...group,
    owner,
    status: isClosed ? "closed" : "open",
    matched: matched.map((message) => message.id),
  };
  const content = [
    `# Task ${group.id}`,
    "",
    `Status: ${metadata.status}`,
    "",
    "The exact source records below retain source IDs, ordering, calls and results. " +
      "Interleaved messages are context, not task membership; matched lists the assigned user IDs.",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    "## Exact conversation and tool context",
    "",
    // Escape literal backticks so source content cannot terminate the JSON fence.
    "```json",
    JSON.stringify(entries, null, 2).replaceAll("`", String.raw`\u0060`),
    "```",
    "",
  ].join("\n");

  await writeTaskFile(taskDirectory(owner), group.file, content);
}

/** Search archive files separately from active grouping and return paths for direct reading.
@param owner - Authorized parent identity.
@param query - User's prior-task reference.
@returns A small ranked set of original Markdown paths and excerpts.
*/
export async function searchTaskArchive(owner: string, query: string) {
  const directory = taskDirectory(owner);
  const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);

  let names: string[];

  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const results = await Promise.all(
    names
      .filter((name) => name.endsWith(".md"))
      .map(async (name) => {
        const file = path.join(directory, name);
        const content = await readFile(file, "utf8");
        const lower = content.toLocaleLowerCase();
        const score = words.filter((word) => lower.includes(word)).length;

        return { file, score, excerpt: content.slice(0, EXCERPT_LENGTH) };
      })
  );

  return results
    .filter((result) => result.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, SEARCH_LIMIT);
}
