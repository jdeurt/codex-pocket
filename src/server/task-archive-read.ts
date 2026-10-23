import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { contextEntrySchema, type ContextEntry } from "./task-archive";
import { nativeText } from "./harness/transcript";
import { object, string } from "../lib/protocol";

/** Project imported canonical history while keeping each native ID and chronological turn membership.
@param value - Exact retained migration envelope.
@returns Source-order records whose originals retain the item and its containing turn ID.
*/
export function legacyEntries(value: unknown): ContextEntry[] {
  const turns = object(value).turns;
  const entries: ContextEntry[] = [];

  if (!Array.isArray(turns)) {
    return entries;
  }

  for (const valueTurn of turns) {
    const turn = object(valueTurn);

    if (!Array.isArray(turn.items)) {
      continue;
    }

    for (const valueItem of turn.items) {
      const item = object(valueItem);

      entries.push({
        id: string(item.id),
        sequence: entries.length,
        role: item.type === "userMessage" ? "user" : "assistant",
        text: string(item.text) || nativeText(item.content),
        original: { ...item, turnId: turn.id, source: "codex" },
      });
    }
  }

  return entries;
}

/** Decode either the current archive envelope or a complete legacy migration.
@param value - Parsed exact JSON.
@returns Retained chronological source records.
*/
function retainedEntries(value: unknown) {
  const entries = object(value).entries;

  return Array.isArray(entries) ? entries.map((entry) => contextEntrySchema.parse(entry)) : legacyEntries(value);
}

/** Reject a view/envelope pair observed between their two atomic writes.
@param markdown - Current reading view.
@param raw - Exact sidecar bytes.
@returns Entries only when the recorded envelope identity agrees.
*/
function coherentEntries(markdown: string, raw: string) {
  const expected = /^Envelope SHA-256: ([a-f0-9]+)$/mu.exec(markdown)?.[1];

  return expected && createHash("sha256").update(raw).digest("hex") !== expected
    ? []
    : retainedEntries(JSON.parse(raw));
}

/** Read an exact sidecar when present, falling back to the original fenced archive format.
@param file - Authorized Markdown path discovered inside this parent's archive directory.
@returns Exact source records and their existing full-record file; no historical files are rewritten.
*/
export async function readTaskArchive(file: string) {
  const rawFile = file.replace(/\.md$/u, ".json");
  const markdown = await readFile(file, "utf8");

  try {
    const rawContent = await readFile(rawFile, "utf8");

    return { entries: coherentEntries(markdown, rawContent), rawFile };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  for (const match of markdown.matchAll(/^```json\n([\s\S]*?)\n```/gmu)) {
    const value: unknown = JSON.parse(match[1]);

    if (Array.isArray(value)) {
      return { entries: value.map((entry) => contextEntrySchema.parse(entry)), rawFile: file };
    }

    const entries = legacyEntries(value);

    if (entries.length > 0) {
      return { entries, rawFile: file };
    }
  }

  return { entries: [], rawFile: file };
}
