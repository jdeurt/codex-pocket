import { z } from "zod";

export const originSchema = z.enum([
  "typed",
  "voice_request",
  "voice_history",
  "delegate_report",
  "assistant",
  "tool_result",
  "recovery",
  "scheduled",
  "legacy",
  "unknown",
]);
export const eventSchema = z.object({
  id: z.string(),
  parentId: z.string(),
  origin: originSchema,
  receiptId: z.string().optional(),
  nativeEntryId: z.string().optional(),
  requestId: z.string().optional(),
  commandId: z.string().optional(),
  causedBy: z.string().optional(),
  inReplyTo: z.string().optional(),
  occurrenceId: z.string().optional(),
  callId: z.string().optional(),
  callIds: z.array(z.string()).default([]),
  text: z.string(),
  contentRefs: z.array(z.string()),
  visibility: z.enum(["user", "internal", "unknown"]),
  delivery: z.enum(["not_delivered", "delivered", "uncertain"]),
});
export const taskSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  title: z.string(),
  originalEventId: z.string(),
  originalIntent: z.string(),
  summary: z.string(),
  pendingQuestions: z.array(z.string()),
  work: z.enum(["open", "waiting", "resolved", "canceled"]),
  retention: z.enum(["active", "archived"]),
  evidence: z.array(z.string()),
});
export const spanSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() });
export const membershipSchema = z.object({
  eventId: z.string(),
  taskId: z.string(),
  span: spanSchema.optional(),
  decisionId: z.string(),
});
const nonemptyTaskIds = z.array(z.string()).min(1);
const RATIONALE_LIMIT = 1000;

export const assignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attach"), taskIds: nonemptyTaskIds, span: spanSchema.optional() }),
  z.object({ kind: z.literal("create"), taskId: z.string(), title: z.string() }),
  z.object({ kind: z.literal("conversation") }),
  z.object({ kind: z.literal("unresolved"), diagnostic: z.string() }),
]);
export const decisionSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  source: z.enum(["correlation", "policy", "classification", "legacy", "correction"]),
  version: z.string(),
  inputRevision: z.number().int(),
  taskRevisions: z.record(z.string(), z.number().int()),
  confidence: z.number().min(0).max(1).nullable(),
  rationale: z.string().max(RATIONALE_LIMIT),
  assignment: assignmentSchema,
  supersedes: z.array(z.string()),
});
export const commandSchema = z.object({ id: z.string(), childId: z.string(), requestId: z.string().nullable() });
export const bindingSchema = z.object({ nativeEntryId: z.string(), receiptId: z.string() });
const commandIntentSchema = z.object({ callId: z.string(), key: z.string(), requestId: z.string().nullable() });

export const ledgerSchema = z.object({
  version: z.literal(1),
  parentId: z.string(),
  revision: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  events: z.array(eventSchema),
  tasks: z.array(taskSchema),
  memberships: z.array(membershipSchema),
  decisions: z.array(decisionSchema),
  commands: z.array(commandSchema),
  bindings: z.array(bindingSchema),
  commandIntents: z.array(commandIntentSchema).default([]),
  mode: z.enum(["shadow", "live"]),
});

export type TaskEvent = z.input<typeof eventSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Ledger = z.infer<typeof ledgerSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Membership = z.infer<typeof membershipSchema>;

/** Allocate a parent-scoped checkpoint with no inferred historical relationships.
@param parentId - Application-owned parent identity.
@returns Empty shadow ledger.
*/
export function initialLedger(parentId: string): Ledger {
  return {
    version: 1,
    parentId,
    revision: 0,
    cursor: null,
    events: [],
    tasks: [],
    memberships: [],
    decisions: [],
    commands: [],
    bindings: [],
    commandIntents: [],
    mode: "shadow",
  };
}
