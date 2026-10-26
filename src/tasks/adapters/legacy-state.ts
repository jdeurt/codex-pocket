import { isParentTaskFile } from "../retrieval/paths";
import { taskDirectory } from "../archive";
import { type TaskContextState, activeStateSchema, initialTaskContext } from "../legacy-model";
import { fileText, optionalFile } from "../../server/optional-file";
import path from "node:path";

/** Restore only active membership and its committed source cursor.
@param owner - Durable parent identity.
@returns Validated active state or an initial checkpoint when absent.
*/
export async function readTaskState(owner: string): Promise<TaskContextState> {
  const filename = path.join(taskDirectory(owner), "active.json");
  const loaded = await optionalFile(fileText, filename);

  if (loaded !== null && !(await isParentTaskFile(owner, filename))) {
    throw new Error("Legacy task checkpoint redirects outside its parent namespace.");
  }

  return loaded === null ? initialTaskContext() : activeStateSchema.parse(JSON.parse(loaded));
}
