import { z } from "zod";

export const tokenBreakdownSchema = z.looseObject({
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  cacheWriteInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative(),
  reasoningOutputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
});
export const contextUsageSchema = z.object({
  total: tokenBreakdownSchema,
  last: tokenBreakdownSchema,
  modelContextWindow: z.number().positive().nullable().optional(),
});

export type ContextUsage = z.infer<typeof contextUsageSchema>;

/**
Expose native usage without treating lifetime totals as current context occupancy.
@param usage - Latest reported native counters, absent before the first notification.
@returns Reported counts, subset relationships and explicitly unknown remaining capacity.
*/
export function contextUsage(usage?: ContextUsage) {
  return {
    source: "thread/tokenUsage/updated",
    unit: "tokens",
    reported: usage ?? null,
    subsets: { cachedInputTokens: "inputTokens", reasoningOutputTokens: "outputTokens" },
    remainingContextTokens: null,
    utilization: null,
    limitation: "Native usage reports token accounting, not an exact live context occupancy.",
  };
}
