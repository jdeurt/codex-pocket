import {
  type ContextEntry,
  type TaskGroup,
  type ActiveMessage,
  activeMessageSchema,
  taskGroupSchema,
} from "./task-archive";
import { findById } from "../lib/identity";
import { z } from "zod";

const LAST_ENTRY = -1;

export const activeStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int(),
  lastSeen: z.number().int(),
  sourceCursor: z.string().nullable(),
  compactionPending: z.boolean().default(false),
  open: taskGroupSchema.nullable(),
  messages: z.array(activeMessageSchema),
});

export type TaskContextState = z.infer<typeof activeStateSchema>;

/** Create an empty active task set without reading historical archives.
@returns Initial ingestion and grouping checkpoint.
*/
export function initialTaskContext(): TaskContextState {
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

/** Append one committed native source entry without mutating prior membership.
@param state - Current active membership and cursor.
@param entry - Original committed native source.
@returns New active context checkpoint.
*/
export function ingestTaskEntry(state: TaskContextState, entry: ContextEntry): TaskContextState {
  const last = state.messages.at(LAST_ENTRY);

  let messages = state.messages;

  if (entry.role === "user") {
    messages = [...messages, { id: entry.id, text: entry.text, entries: [entry] }];
  } else if (last) {
    messages = [...messages.slice(0, LAST_ENTRY), { ...last, entries: [...last.entries, entry] }];
  }

  return { ...state, messages, sourceCursor: entry.id, revision: state.revision + 1 };
}

/** Resolve a stable open group and its candidate suffix.
@param state - Current active checkpoint.
@param generatedId - Runtime-provided identity used only for a new group.
@returns Original anchor, stable group and subsequent candidates.
*/
export function taskPass(state: TaskContextState, generatedId: string) {
  const anchor = state.open ? findById(state.messages, state.open.anchor) : state.messages[0];

  if (!anchor) {
    throw new Error("Active task anchor is missing; retained state needs inspection.");
  }

  const group = state.open ?? { id: generatedId, file: `${generatedId}.md`, anchor: anchor.id, matched: [anchor.id] };

  return { anchor, group, candidates: state.messages.slice(state.messages.indexOf(anchor) + 1) };
}

/** Select the original text of a task member.
@param message - Original active user message.
@returns Original user text.
*/
export function taskMessageText(message: ActiveMessage) {
  return message.text;
}

/** Select a stable task member identity.
@param message - Original active user message.
@returns Native source identity.
*/
export function taskMessageId(message: ActiveMessage) {
  return message.id;
}

/** Commit grouped membership without retaining closed tasks in the active set.
@param state - Current active checkpoint.
@param group - Original stable task identity.
@param matched - Classifier-confirmed user messages.
@param isClosed - Whether the nonmatch threshold was reached.
@returns Group metadata and next active checkpoint.
*/
export function groupedTask(state: TaskContextState, group: TaskGroup, matched: ActiveMessage[], isClosed: boolean) {
  const completed = { ...group, matched: Array.from(matched, taskMessageId) };
  const membership = new Set(completed.matched);
  const remaining: ActiveMessage[] = [];

  for (const message of state.messages) {
    if (!membership.has(message.id)) {
      remaining.push(message);
    }
  }

  return {
    group: completed,
    state: {
      ...state,
      open: isClosed ? null : completed,
      messages: isClosed ? remaining : state.messages,
      compactionPending: state.compactionPending || isClosed,
    },
  };
}

/** Select the examined original source interval for task archival.
@param group - Stable group with a verified active anchor.
@param working - Current active user messages.
@returns Original chronological source records beginning at the anchor.
*/
export function taskEnvelopeEntries(group: TaskGroup, working: ActiveMessage[]) {
  const anchor = findById(working, group.anchor);

  if (!anchor) {
    throw new Error("The task archive anchor is missing from active context.");
  }

  const entries: ContextEntry[] = [];

  const active = working.slice(working.indexOf(anchor));

  for (const message of active) {
    entries.push(...message.entries);
  }

  return entries;
}
