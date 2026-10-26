import path from "node:path";
import { fileText, optionalFile } from "../server/optional-file";
import { taskDirectory, writeTaskFile } from "./archive";
import { readTaskLedger } from "./management";
import { readTaskSources } from "./sources";
import { isTaskAuthoritative } from "./model";
import { taskMarkdown, taskProjectionName } from "./projection-model";

/** Replace a navigation projection only when its contents changed.
@param directory - Authorized private namespace.
@param name - Host-generated basename.
@param body - Derived Markdown.
*/
export async function writeProjection(directory: string, name: string, body: string) {
  const previous = await optionalFile(fileText, path.join(directory, name));

  if (previous !== body) {
    await writeTaskFile(directory, name, body);
  }
}

/** Regenerate task navigation from a committed ledger; interrupted writes are rebuilt on reconciliation.
@param parentId - Authorized parent.
@returns Exact snapshot and stable task-to-file references.
*/
export async function regenerateTaskProjections(parentId: string) {
  const state = readTaskLedger(parentId);
  const directory = taskDirectory(parentId);
  const sources = await readTaskSources(parentId);
  const taskFiles = new Map<string, string>();

  for (const task of state.tasks) {
    if (!isTaskAuthoritative(state.mode, task)) {
      continue;
    }

    const name = taskProjectionName(task.id);

    await writeProjection(directory, name, taskMarkdown(state, task, directory, sources));
    taskFiles.set(task.id, path.join(directory, name));
  }

  return { state, taskFiles };
}
