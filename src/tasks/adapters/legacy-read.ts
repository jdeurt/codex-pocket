import { readFile } from "node:fs/promises";
import { contextEntriesSchema, coherentEntries, legacyEntries } from "./legacy-model";
import { fileText, optionalFile } from "../../server/optional-file";

export { legacyEntries } from "./legacy-model";

/** Read an exact sidecar when present, falling back to the original fenced archive format.
@param file - Authorized Markdown path discovered inside this parent's archive directory.
@returns Exact source records and their existing full-record file; no historical files are rewritten.
*/
export async function readTaskArchive(file: string) {
  const rawFile = file.replace(/\.md$/u, ".json");
  const markdown = await readFile(file, "utf8");

  const source = await optionalFile(fileText, rawFile);

  if (source !== null) {
    return { entries: coherentEntries(markdown, source), rawFile };
  }

  for (const match of markdown.matchAll(/^```json\n([\s\S]*?)\n```/gmu)) {
    const value: unknown = JSON.parse(match[1]);

    if (Array.isArray(value)) {
      return { entries: contextEntriesSchema.parse(value), rawFile: file };
    }

    const entries = legacyEntries(value);

    if (entries.length > 0) {
      return { entries, rawFile: file };
    }
  }

  return { entries: [], rawFile: file };
}
