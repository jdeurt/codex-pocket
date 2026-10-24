export interface CodeLine {
  id: string;
  text: string;
}

/** Give duplicate literal lines stable occurrence identities without changing the source.
@param source - Code content, which may also be structured React content.
@returns Numbered-line data for a string, otherwise no derived lines.
*/
export function codeLines(source: unknown): CodeLine[] {
  if (typeof source !== "string") {
    return [];
  }

  const occurrences = new Map<string, number>();
  const lines: CodeLine[] = [];
  const sourceLines = source.replace(/\n$/, "").split("\n");

  for (const text of sourceLines) {
    const occurrence = (occurrences.get(text) ?? 0) + 1;

    occurrences.set(text, occurrence);
    lines.push({ id: `${text}:${String(occurrence)}`, text });
  }

  return lines;
}
