import path from "node:path";
import { legacyEntries } from "./legacy-read";
import { taskDirectory, writeTaskFile } from "../archive";
import { sourceLink, taskTimeline } from "../render";
import { scheduleTaskIndex } from "../retrieval/runtime";

/** Write a readable imported timeline beside the complete unchanged native migration envelope.
@param owner - Parent whose native Codex history is being imported.
@param original - Exact serialized native history, also retained in Pi's custom migration entry.
*/
export async function writeLegacyTask(owner: string, original: string) {
  const directory = taskDirectory(owner);
  const rawFile = path.join(directory, "legacy-codex.json");
  const entries = legacyEntries(JSON.parse(original));

  await writeTaskFile(directory, "legacy-codex.json", original);
  await writeTaskFile(
    directory,
    "legacy-codex.md",
    [
      "# Imported Codex conversation",
      "",
      `Source thread: ${JSON.stringify(owner)}`,
      "",
      `[Full exact native history](${sourceLink(rawFile)})`,
      "",
      taskTimeline(entries, { file: rawFile }),
    ].join("\n")
  );
  scheduleTaskIndex(owner);
}
