import { dataSchema } from "../lib/protocol";
import { z } from "zod";

const clientRecordSchema = z.object({
  id: z.string(),
  time: z.string(),
  level: z.enum(["info", "error"]),
  event: z.string(),
  details: dataSchema,
});

export type ClientRecord = z.infer<typeof clientRecordSchema>;

/** Validate optional saved diagnostics without reading browser storage.
@param source - Serialized saved diagnostics.
@returns Valid records in saved order, excluding invalid individual entries.
*/
export function parsedDiagnostics(source: string): ClientRecord[] {
  const saved: unknown = JSON.parse(source);
  const records: ClientRecord[] = [];

  if (Array.isArray(saved)) {
    for (const entry of saved) {
      const parsed = clientRecordSchema.safeParse(entry);

      if (parsed.success) {
        records.push(parsed.data);
      }
    }
  }

  return records;
}

/** Remove only acknowledged identities, preserving records added during a send.
@param records - Current runtime queue.
@param acknowledged - Exact successfully transmitted batch.
@returns Remaining records without changing either input.
*/
export function remainingDiagnostics(records: ClientRecord[], acknowledged: ClientRecord[]) {
  const ids = new Set<string>();
  const remaining: ClientRecord[] = [];

  for (const entry of acknowledged) {
    ids.add(entry.id);
  }

  for (const entry of records) {
    if (!ids.has(entry.id)) {
      remaining.push(entry);
    }
  }

  return remaining;
}

/** Preserve exception details as a serializable diagnostic value.
@param error - Rejected value received at a runtime boundary.
@returns Exception metadata or a textual representation.
*/
export function clientError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}
