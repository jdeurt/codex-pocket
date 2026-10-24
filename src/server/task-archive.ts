import { taskEnvelopeEntries, taskMessageId } from "../state/task-context";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { localDirectory } from "./local-state";
import path from "node:path";
import { scheduleTaskIndex } from "./task-search";
import { sourceLink, taskTimeline } from "../state/task-record";

export { searchTaskArchive } from "./task-search";

const LAST_ENTRY = -1;

import { contextEntrySchema, type ContextEntry, type TaskGroup, type ActiveMessage } from "../state/task-archive";

export {
  contextEntrySchema,
  activeMessageSchema,
  taskGroupSchema,
  type ContextEntry,
  type TaskGroup,
  type ActiveMessage,
} from "../state/task-archive";

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
  const activeEntries = taskEnvelopeEntries(group, working);
  const entries = await sourceEnvelope(owner, activeEntries);
  const metadata = {
    ...group,
    owner,
    status: isClosed ? "closed" : "open",
    matched: Array.from(matched, taskMessageId),
  };
  const directory = taskDirectory(owner);
  const rawFile = group.file.replace(/\.md$/u, ".json");

  // Keep the exact envelope outside the reading view, including unknown native fields.
  const rawContent = JSON.stringify({ metadata, entries }, null, 2);

  await writeTaskFile(directory, rawFile, rawContent);
  const content = [
    `# Task ${group.id}`,
    "",
    `Status: ${metadata.status}`,
    `Envelope SHA-256: ${createHash("sha256").update(rawContent).digest("hex")}`,
    `Owner: ${JSON.stringify(owner)}`,
    `Anchor: ${JSON.stringify(group.anchor)}`,
    `Matched user IDs: ${JSON.stringify(metadata.matched)}`,
    "",
    "Records are in source order. User headings group subsequent messages; tool-result references " +
      "retain call ownership across interleaved users. Interleaved context is not task membership.",
    "",
    `[Full exact envelope and metadata](${sourceLink(path.join(directory, rawFile))})`,
    "All native fields remain in the source files. Previews omit non-text content and explicitly truncate long text.",
    "",
    taskTimeline(entries, { directory }),
  ].join("\n");

  await writeTaskFile(directory, group.file, content);
  scheduleTaskIndex(owner);
}
