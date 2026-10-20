import { z } from "zod";

export const delegateReportSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  status: z.enum(["pending", "streaming", "completed", "failed"]),
});
export type DelegateReport = z.infer<typeof delegateReportSchema>;
