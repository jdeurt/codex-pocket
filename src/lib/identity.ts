/** Find an entry using an explicit identity rather than a capturing callback.
@param entries - Read-only candidates.
@param id - Requested identity, including unchecked protocol input.
@returns Matching entry, or undefined.
*/
export function findById<T extends { id: string | number }>(entries: readonly T[], id: unknown): T | undefined {
  for (const entry of entries) {
    if (entry.id === id) {
      return entry;
    }
  }
}

/** Replace an identified entry while preserving order and unrelated references.
@param entries - Previous entries, left unchanged.
@param value - Replacement, appended when absent.
@returns New ordered collection.
*/
export function upsertById<T extends { id: string | number }>(entries: readonly T[], value: T): T[] {
  const next: T[] = [];

  let isFound = false;

  for (const entry of entries) {
    next.push(entry.id === value.id ? value : entry);
    isFound ||= entry.id === value.id;
  }

  return isFound ? next : [...next, value];
}

/** Remove an identified entry without changing the source collection.
@param entries - Previous entries.
@param id - Identity to remove.
@returns Remaining entries in their existing order.
*/
export function withoutId<T extends { id: string | number }>(entries: readonly T[], id: unknown): T[] {
  const next: T[] = [];

  for (const entry of entries) {
    if (entry.id !== id) {
      next.push(entry);
    }
  }

  return next;
}
