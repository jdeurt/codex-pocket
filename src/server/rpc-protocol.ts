import { dataSchema, itemSchema, threadSchema, turnSchema } from "../lib/protocol";
import { z } from "zod";

export const sessionResponseSchema = z.looseObject({
  thread: threadSchema,
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  approvalPolicy: z.unknown().optional(),
  sandbox: z.looseObject({ type: z.string() }).optional(),
});
export const threadResponseSchema = z.looseObject({ thread: threadSchema });
export const turnResponseSchema = z.looseObject({ turn: turnSchema });
export const configResponseSchema = z.looseObject({ config: dataSchema });
export const threadsPageSchema = z.looseObject({ data: z.array(threadSchema), nextCursor: z.string().nullable() });
export const turnsPageSchema = z.looseObject({ data: z.array(turnSchema), nextCursor: z.string().nullable() });
export const itemsPageSchema = z.looseObject({
  data: z.array(z.looseObject({ item: itemSchema })),
  nextCursor: z.string().nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export const rpcResponseSchemas = new Map<string, z.ZodType>([
  ["thread/start", sessionResponseSchema],
  ["thread/resume", sessionResponseSchema],
  ["thread/read", threadResponseSchema],
  ["turn/start", turnResponseSchema],
  ["config/read", configResponseSchema],
  ["thread/list", threadsPageSchema],
  ["thread/turns/list", turnsPageSchema],
  ["thread/items/list", itemsPageSchema],
]);
