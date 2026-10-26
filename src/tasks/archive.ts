import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { localDirectory } from "../server/local-state";
import path from "node:path";
import { preserveTaskSource } from "./source-io";

export { searchTaskArchive } from "./retrieval/runtime";

import { type ContextEntry } from "./archive-model";

export {
  contextEntrySchema,
  activeMessageSchema,
  taskGroupSchema,
  type ContextEntry,
  type TaskGroup,
  type ActiveMessage,
} from "./archive-model";

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
  return preserveTaskSource(
    path.join(taskDirectory(owner), "source"),
    `${String(entry.sequence)}.json`,
    JSON.stringify(entry)
  );
}
