import { z } from "zod";

export const delegateReportSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  status: z.enum(["pending", "streaming", "completed", "failed"]),
  final: z.object({ commandId: z.string(), outcome: z.literal("completed") }).optional(),
});

export type DelegateReport = z.infer<typeof delegateReportSchema>;
