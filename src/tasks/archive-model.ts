import { z } from "zod";

export const contextEntrySchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  role: z.string(),
  text: z.string(),
  original: z.unknown(),
});

export type ContextEntry = z.infer<typeof contextEntrySchema>;
export const activeMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  entries: z.array(contextEntrySchema),
});

export type ActiveMessage = z.infer<typeof activeMessageSchema>;
export const taskGroupSchema = z.object({
  id: z.uuid(),
  file: z.string(),
  anchor: z.string(),
  matched: z.array(z.string()),
});

export type TaskGroup = z.infer<typeof taskGroupSchema>;
