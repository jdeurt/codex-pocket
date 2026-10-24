import { t as captureResult } from "try";
import {
  type ContextEntry,
  type TaskGroup,
  activeMessageSchema,
  archiveTask,
  taskDirectory,
  taskGroupSchema,
  writeTaskFile,
} from "./task-archive";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const activeStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int(),
  lastSeen: z.number().int(),
  sourceCursor: z.string().nullable(),
  compactionPending: z.boolean().default(false),
  open: taskGroupSchema.nullable(),
  messages: z.array(activeMessageSchema),
});

export type TaskContextState = z.infer<typeof activeStateSchema>;
const NONMATCH_LIMIT = 5;
const LAST_ENTRY = -1;

/** Restore only active membership and the ingestion cursor; closed archives are never opened here.
@param owner - Exact durable parent identity.
@returns Persisted active working set, or a fresh state when absent.
*/
export async function readTaskState(owner: string): Promise<TaskContextState> {
  const loaded = await captureResult(() => readFile(path.join(taskDirectory(owner), "active.json"), "utf8"));

  if (loaded.ok) {
    return activeStateSchema.parse(JSON.parse(loaded.value));
  }

  const error = loaded.error;

  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }

  return {
    version: 1,
    revision: 0,
    lastSeen: -1,
    sourceCursor: null,
    compactionPending: false,
    open: null,
    messages: [],
  };
}

/** Persist active membership atomically after source ingestion or a successful pass.
@param owner - Owning parent identity.
@param state - Active state with no closed-group membership.
@returns Completion after the active state is durable.
*/
export function saveTaskState(owner: string, state: TaskContextState) {
  return writeTaskFile(taskDirectory(owner), "active.json", JSON.stringify(state, null, 2) + "\n");
}

/** Add one newly finalized source entry without traversing historical task membership.
@param state - Directly maintained active working set.
@param entry - Exact native entry in source order.
*/
export function ingestTaskEntry(state: TaskContextState, entry: ContextEntry) {
  if (entry.role === "user") {
    state.messages.push({ id: entry.id, text: entry.text, entries: [entry] });
  } else {
    state.messages.at(LAST_ENTRY)?.entries.push(entry);
  }

  state.sourceCursor = entry.id;
  state.revision++;
}

/** Resume an open anchor, then close tasks only after five consecutive nonmatching user messages.
@param owner - Owning parent namespace.
@param state - Snapshot of the directly maintained active set; callers serialize ingestion with this pass.
@param isSameTask - Classifier comparing a candidate against every currently matched user message.
@returns Closed task IDs suitable for a later context-compaction boundary.
*/
export async function groupTaskContext(
  owner: string,
  state: TaskContextState,
  isSameTask: (candidate: string, matched: string[]) => Promise<boolean>
) {
  const closed: string[] = [];

  if (state.revision === state.lastSeen) {
    return closed;
  }

  while (state.messages.length > 0) {
    const anchor = state.open ? state.messages.find((message) => message.id === state.open?.anchor) : state.messages[0];

    if (!anchor) {
      throw new Error("Active task anchor is missing; retained state needs inspection.");
    }

    const id = state.open?.id ?? crypto.randomUUID();
    const group: TaskGroup = state.open ?? { id, file: `${id}.md`, anchor: anchor.id, matched: [anchor.id] };
    const matched = [anchor];

    state.open = group;
    // Checkpoint the stable file identity before a provider failure can interrupt classification.
    await saveTaskState(owner, state);

    let nonmatches = 0;

    const candidates = state.messages.slice(state.messages.indexOf(anchor) + 1);

    for (let index = 0; index < candidates.length && nonmatches < NONMATCH_LIMIT; index++) {
      const candidate = candidates[index];

      if (
        await isSameTask(
          candidate.text,
          matched.map((message) => message.text)
        )
      ) {
        matched.push(candidate);
        nonmatches = 0;
      } else {
        nonmatches++;
      }
    }

    group.matched = matched.map((message) => message.id);
    await archiveTask(owner, group, matched, state.messages, nonmatches === NONMATCH_LIMIT);

    if (nonmatches < NONMATCH_LIMIT) {
      state.open = group;
      break;
    }

    closed.push(group.id);
    const membership = new Set(group.matched);

    state.messages = state.messages.filter((message) => !membership.has(message.id));
    state.open = null;
    state.compactionPending = true;
    await saveTaskState(owner, state);
  }

  state.lastSeen = state.revision;
  await saveTaskState(owner, state);

  return closed;
}
