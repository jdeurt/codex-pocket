import { createHash } from "node:crypto";
import { contextEntrySchema, type ContextEntry } from "./task-archive";
import { nativeText } from "../server/harness/transcript";
import { object, string } from "../lib/protocol";
import { z } from "zod";

export const contextEntriesSchema = z.array(contextEntrySchema);

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

  return Array.isArray(entries) ? contextEntriesSchema.parse(entries) : legacyEntries(value);
}

/** Reject a view/envelope pair observed between their two atomic writes.
@param markdown - Current reading view.
@param raw - Exact sidecar bytes.
@returns Entries only when the recorded envelope identity agrees.
*/
export function coherentEntries(markdown: string, raw: string) {
  const expected = /^Envelope SHA-256: ([a-f0-9]+)$/mu.exec(markdown)?.[1];

  return expected && createHash("sha256").update(raw).digest("hex") !== expected
    ? []
    : retainedEntries(JSON.parse(raw));
}
