import { archiveTask, taskDirectory, writeTaskFile } from "./task-archive";
import {
  type TaskContextState,
  activeStateSchema,
  initialTaskContext,
  taskPass,
  groupedTask,
  taskMessageText,
} from "../state/task-context";
import { fileText, optionalFile } from "./optional-file";
import path from "node:path";

export { type TaskContextState, ingestTaskEntry } from "../state/task-context";
const NONMATCH_LIMIT = 5;

/** Restore only active membership and its committed source cursor.
@param owner - Durable parent identity.
@returns Validated active state or an initial checkpoint when absent.
*/
export async function readTaskState(owner: string): Promise<TaskContextState> {
  const loaded = await optionalFile(fileText, path.join(taskDirectory(owner), "active.json"));

  return loaded === null ? initialTaskContext() : activeStateSchema.parse(JSON.parse(loaded));
}

/** Atomically replace the active membership checkpoint.
@param owner - Durable parent identity.
@param state - Immutable active checkpoint.
@returns Completion after the checkpoint is durable.
*/
export function saveTaskState(owner: string, state: TaskContextState) {
  return writeTaskFile(taskDirectory(owner), "active.json", JSON.stringify(state, null, 2) + "\n");
}

/** Classify active membership with durable checkpoints before provider calls.
@param owner - Durable parent identity.
@param state - Initial active checkpoint, left unchanged.
@param isSameTask - Provider classifier comparing original user text.
@returns New checkpoint and identities archived as closed tasks.
*/
export async function groupTaskContext(
  owner: string,
  state: TaskContextState,
  isSameTask: (candidate: string, matched: string[]) => Promise<boolean>
) {
  const closed: string[] = [];

  let current = state;

  if (current.revision === current.lastSeen) {
    return { state: current, closed };
  }

  while (current.messages.length > 0) {
    const pass = taskPass(current, crypto.randomUUID());
    const matched = [pass.anchor];

    current = { ...current, open: pass.group };
    await saveTaskState(owner, current);
    let nonmatches = 0;

    for (let index = 0; index < pass.candidates.length && nonmatches < NONMATCH_LIMIT; index++) {
      const candidate = pass.candidates[index];

      if (await isSameTask(candidate.text, Array.from(matched, taskMessageText))) {
        matched.push(candidate);
        nonmatches = 0;
      } else {
        nonmatches++;
      }
    }

    const isClosed = nonmatches === NONMATCH_LIMIT;
    const grouped = groupedTask(current, pass.group, matched, isClosed);

    await archiveTask(owner, grouped.group, matched, current.messages, isClosed);
    current = grouped.state;

    if (!isClosed) {
      break;
    }

    closed.push(grouped.group.id);
    await saveTaskState(owner, current);
  }

  current = { ...current, lastSeen: current.revision };
  await saveTaskState(owner, current);

  return { state: current, closed };
}
