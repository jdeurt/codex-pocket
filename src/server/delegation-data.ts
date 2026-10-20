import { dataSchema } from "../lib/protocol";
import { z } from "zod";

export const parentPolicySchema = z.object({
  sandbox: z.string(),
  approval: z.unknown(),
  model: z.string().optional(),
  effort: z.string().nullable().optional(),
  workspace: dataSchema.optional(),
});
export const parentContextSchema = z.object({ cwd: z.string(), policy: parentPolicySchema });
export const storedPocketSchema = z.object({
  id: z.string(),
  parentId: z.string(),
  title: z.string(),
  cwd: z.string(),
  sessionId: z.string().nullable().optional(),
  sessionStarted: z.boolean().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  policy: z.string(),
  harness: z.enum(["codex", "claude"]),
  status: z.enum(["idle", "running", "waiting", "closing", "closed", "unknown"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  metadata: z.string(),
  createKey: z.string(),
  fingerprint: z.string(),
});
export const commandStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "unknown",
  "cancelled",
  "pending",
  "sending",
  "accepted",
  "unsupported",
]);
export const delegationCommandSchema = z.object({
  id: z.string(),
  childId: z.string(),
  parentId: z.string(),
  mode: z.enum(["steer", "queue"]),
  targetId: z.string().nullable(),
  turnId: z.string().nullable(),
  supersedes: z.string(),
  body: z.string(),
  key: z.string(),
  createdAt: z.number(),
  status: commandStatusSchema,
  result: z.string().nullable(),
});
export const delegationMailSchema = z.object({
  id: z.string(),
  childId: z.string(),
  parentId: z.string(),
  sourceId: z.string(),
  kind: z.string(),
  payload: z.string(),
  delivery: z.enum(["pending", "queued", "sent", "unknown", "local"]),
  createdAt: z.number(),
});
export const delegationRequestSchema = z.object({
  id: z.string(),
  childId: z.string(),
  parentId: z.string(),
  nativeId: z.string(),
  method: z.string(),
  input: z.string(),
  createdAt: z.number(),
  answer: z.string().nullable(),
  status: z.enum(["pending", "answered", "cancelled"]),
});

export type StoredPocket = z.infer<typeof storedPocketSchema>;
export const sidePocketSchema = storedPocketSchema.extend({ policy: parentPolicySchema });

export type SidePocket = z.infer<typeof sidePocketSchema>;
export type ParentContext = z.infer<typeof parentContextSchema>;
export type DelegationCommand = z.infer<typeof delegationCommandSchema>;

/**
Validate serialized parent policy while normalizing a persisted Side Pocket row.
@param row - Database row already checked by the stored-pocket schema.
@returns Side Pocket with its parsed native parent policy.
*/
export function pocket(row: StoredPocket): SidePocket {
  return { ...row, policy: parentPolicySchema.parse(JSON.parse(row.policy)) };
}
