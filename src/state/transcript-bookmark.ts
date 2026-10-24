import { z } from "zod";

const itemSchema = z.object({
  index: z.number(),
  start: z.number(),
  end: z.number(),
  size: z.number(),
  key: z.union([z.string(), z.number()]),
  lane: z.number(),
});
const bookmarkSchema = z.object({
  offset: z.number().nonnegative(),
  atEnd: z.boolean(),
  measurements: z.array(itemSchema),
  expanded: z.array(z.string()),
});

export type TranscriptBookmark = z.infer<typeof bookmarkSchema>;

/** Validate optional serialized native measurements without coercion.
@param source - Optional browser-storage value.
@returns Valid saved geometry, or no bookmark when absent.
*/
export function parseBookmark(source: string | null) {
  return source ? bookmarkSchema.parse(JSON.parse(source)) : undefined;
}
