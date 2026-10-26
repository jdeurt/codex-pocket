import { activeMessageSchema, taskGroupSchema } from "./archive-model";
import { z } from "zod";

export const activeStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int(),
  lastSeen: z.number().int(),
  sourceCursor: z.string().nullable(),
  compactionPending: z.boolean().default(false),
  open: taskGroupSchema.nullable(),
  messages: z.array(activeMessageSchema),
});

export type TaskContextState = z.infer<typeof activeStateSchema>;

/** Create an empty active task set without reading historical archives.
@returns Initial ingestion and grouping checkpoint.
*/
export function initialTaskContext(): TaskContextState {
  return {
    version: 1,
    revision: 0,
    lastSeen: -1,
    sourceCursor: null,
    compactionPending: false,
    open: null,
    messages: [],
  };
}
