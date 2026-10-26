import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionalFile, directoryNames } from "../server/optional-file";
import { taskDirectory } from "./archive";
import { contextEntrySchema, type ContextEntry } from "./archive-model";
import { isParentTaskFile } from "./retrieval/paths";

export interface TaskSource {
  entry: ContextEntry;
  file: string;
}

/** Order exact sources by their stored chronological sequence.
@param first - First original.
@param second - Second original.
@returns Source order.
*/
function compareSources(first: TaskSource, second: TaskSource) {
  return first.entry.sequence - second.entry.sequence;
}

/** Read each exact native source once from its authorized parent namespace.
@param parentId - Owning parent.
@returns Validated records in recorded source order.
*/
export async function readTaskSources(parentId: string): Promise<TaskSource[]> {
  const directory = path.join(taskDirectory(parentId), "source");
  const names = (await optionalFile(directoryNames, directory)) ?? [];
  const sources: TaskSource[] = [];

  for (const name of names) {
    if (!/^\d+\.json$/u.test(name)) {
      continue;
    }

    const file = path.join(directory, name);

    if (!(await isParentTaskFile(parentId, file))) {
      continue;
    }

    const entry = contextEntrySchema.parse(JSON.parse(await readFile(file, "utf8")));

    sources.push({ entry, file });
  }

  return sources.toSorted(compareSources);
}
