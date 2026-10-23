import assert from "node:assert/strict";
import { z } from "zod";

const envelopeSchema = z.object({
  source: z.string().min(1),
  visibility: z.literal("internal"),
  userDelivery: z.literal("not_delivered_by_this_message"),
  authority: z.literal("context_only_no_new_user_authorization"),
  content: z.string(),
});

/**
Validate the actual model input before a fixture interprets its original scenario or result.
@param text - Input captured at a native model boundary.
@returns Complete original payload and host-provided visibility metadata.
*/
export function readInternalContext(text: string) {
  const marker = "[POCKET_INTERNAL_CONTEXT]\n";

  assert.ok(text.startsWith(marker), "Internal model input must start with its visibility marker");

  return envelopeSchema.parse(JSON.parse(text.slice(marker.length)));
}
