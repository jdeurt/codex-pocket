import { z } from "zod";

const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 32_768;
export const delegationKey = z.string().trim().min(1).max(MAX_TITLE_LENGTH);
export const delegationBody = z.string().trim().min(1).max(MAX_BODY_LENGTH);
export const delegationInput = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    body: delegationBody,
    harness: z.enum(["codex", "claude"]).default("codex"),
    cwd: z.string().startsWith("/").optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    idempotencyKey: delegationKey,
  })
  .strict();

/**
Validate a command's idempotency key before its exact body using the shared input schemas.
@param key - Caller-supplied stable command key.
@param body - Exact follow-up body to persist after trimming and size validation.
@returns Validated command body after key validation succeeds.
*/
export function commandText(key: string, body: string) {
  delegationKey.parse(key);

  return delegationBody.parse(body);
}
