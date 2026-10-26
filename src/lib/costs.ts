import { z } from "zod";

export const COST_FEATURES = {
  main: "Main agent",
  context: "Context & compaction",
  task_intent: "Task membership",
  task_lifecycle: "Task completion",
  voice: "Live voice",
  delegates: "Side Pockets",
} as const;
export const costFeatureSchema = z.enum(["main", "context", "task_intent", "task_lifecycle", "voice", "delegates"]);

export type CostFeature = z.infer<typeof costFeatureSchema>;
const TIMEZONE_LIMIT = 100;
const MODEL_LIMIT = 200;
const count = z.number().nonnegative();
export const costObservationSchema = z.object({
  id: z.string().min(1),
  timestamp: z.iso.datetime(),
  parentId: z.string(),
  feature: costFeatureSchema,
  provider: z.string(),
  model: z.string(),
  status: z.enum(["pending", "complete", "failed", "aborted"]),
  inputTokens: count.nullable(),
  cachedInputTokens: count.nullable(),
  cacheWriteTokens: count.nullable(),
  outputTokens: count.nullable(),
  seconds: count.nullable(),
  amountUSD: count.nullable(),
  costKind: z.enum(["estimated", "reported"]).nullable(),
  pricingSource: z.string().nullable(),
});

export type CostObservation = z.infer<typeof costObservationSchema>;
export type CostScope = Pick<CostObservation, "parentId" | "feature" | "provider" | "model">;
export const costQuerySchema = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  timezone: z.string().max(TIMEZONE_LIMIT),
  feature: costFeatureSchema.optional(),
  model: z.string().min(1).max(MODEL_LIMIT).optional(),
});

export type CostQuery = z.infer<typeof costQuerySchema>;
export const costGroupSchema = z.object({
  day: z.string(),
  feature: costFeatureSchema,
  model: z.string(),
  provider: z.string(),
  calls: count,
  unknownCosts: count,
  pending: count,
  failed: count,
  estimatedUSD: count,
  reportedUSD: count,
  reportedRecords: count,
  inputTokens: count,
  outputTokens: count,
  cachedInputTokens: count,
  seconds: count,
});

export type CostGroup = z.infer<typeof costGroupSchema>;
export const costReportSchema = z.object({
  query: costQuerySchema,
  generatedAt: z.iso.datetime(),
  trackingSince: z.string().nullable(),
  models: z.array(z.string()),
  groups: z.array(costGroupSchema),
  pricingSources: z.array(z.string()),
});

export type CostReport = z.infer<typeof costReportSchema>;
