import { type Data, dataSchema, itemSchema, object, threadSchema, turnSchema } from "../lib/protocol";
import { log } from "./logging";
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

/**
Preserve native JSON-RPC error codes and uncertain acknowledgement failures.
*/
export class RpcError extends Error {
  /**
  Create a protocol failure while retaining its optional native code.
  @param message - Native or transport failure description.
  @param code - Native JSON-RPC error code, when supplied.
  */
  constructor(
    message: string,
    public code?: number
  ) {
    super(message);
  }
}

/**
Decode one native JSON line and keep malformed output in host diagnostics.
@param line - Native stdout line before protocol validation.
@returns A decoded object, or undefined when JSON parsing fails.
*/
export function decodeRpcLine(line: string): Data | undefined {
  try {
    return object(JSON.parse(line));
  } catch (error) {
    log().warn({ error, line }, "codex.stdout.invalid_json");

    return undefined;
  }
}
