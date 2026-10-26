import { z } from "zod";
import { messageSourceSchema } from "../lib/protocol";

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
  voiceSource: messageSourceSchema.optional(),
  nativeEntryId: z.string().optional(),
  nativeRole: z.string().optional(),
  requestId: z.string().optional(),
  requestIds: z.array(z.string()).default([]),
  turnId: z.string().optional(),
  commandId: z.string().optional(),
  causedBy: z.string().optional(),
  inReplyTo: z.string().optional(),
  occurrenceId: z.string().optional(),
  callId: z.string().optional(),
  callIds: z.array(z.string()).default([]),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  text: z.string(),
  contentRefs: z.array(z.string()),
  references: z.array(z.string()).default([]),
  visibility: z.enum(["user", "internal", "unknown"]),
  delivery: z.enum(["not_delivered", "delivered", "uncertain"]),
});
export const taskSchema = z.object({
  authority: z.enum(["proposal", "live", "legacy"]).default("proposal"),
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
  z.object({ kind: z.literal("create"), taskId: z.string(), title: z.string(), originalIntent: z.string().optional() }),
  z.object({ kind: z.literal("conversation") }),
  z.object({ kind: z.literal("unresolved"), diagnostic: z.string() }),
]);
const idList = z.array(z.string()).min(1);
const questionList = z.array(z.string());
const operationSpanSchema = z.object({ taskId: z.string(), start: z.number().int(), end: z.number().int() });
const operationSpans = z.array(operationSpanSchema);
const resolutionSchema = z.object({
  basis: z.enum(["result", "user_confirmation", "delivered_answer"]),
  verification: z.string().trim().min(1).max(RATIONALE_LIMIT),
  deliveryRequired: z.boolean(),
});

export const taskOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assign"), eventId: z.string(), assignment: assignmentSchema }),
  z.object({
    kind: z.literal("work"),
    taskId: z.string(),
    work: z.enum(["open", "waiting", "resolved", "canceled"]),
    evidence: idList,
    summary: z.string().optional(),
    pendingQuestions: questionList.optional(),
    resolution: resolutionSchema.optional(),
  }),
  z.object({ kind: z.literal("retain"), taskId: z.string(), retention: z.enum(["active", "archived"]) }),
  z.object({
    kind: z.literal("move"),
    eventId: z.string(),
    taskIds: idList,
    spans: operationSpans.optional(),
  }),
  z.object({
    kind: z.literal("split"),
    taskId: z.string(),
    newTaskId: z.string(),
    title: z.string(),
    eventIds: idList,
  }),
  z.object({ kind: z.literal("merge"), taskIds: idList, targetTaskId: z.string() }),
]);

export type TaskOperation = z.infer<typeof taskOperationSchema>;

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
export const commandSchema = z.object({
  id: z.string(),
  childId: z.string(),
  requestId: z.string().nullable(),
  requestIds: z.array(z.string()).default([]),
});
export const bindingSchema = z.object({ nativeEntryId: z.string(), receiptId: z.string() });
const commandIntentSchema = z.object({
  callId: z.string(),
  key: z.string(),
  requestId: z.string().nullable(),
  requestIds: z.array(z.string()).default([]),
});

const lifecycleChangeSchema = z.object({
  id: z.string(),
  inputRevision: z.number().int(),
  operation: z.unknown(),
  reason: z.string(),
});
const lifecycleReviewSchema = z.object({
  taskId: z.string(),
  source: z.enum(["classification", "policy"]).default("classification"),
  requestEventId: z.string().optional(),
  inputEvents: z.array(z.string()).default([]),
  requestEvents: z.array(z.string()).default([]),
  isMainTurnActive: z.boolean().optional(),
  inputHash: z.string(),
  version: z.string(),
  inputRevision: z.number().int(),
  taskRevision: z.number().int(),
  probabilities: z.record(z.string(), z.number()),
  evidence: z.array(z.string()),
  outcome: z.enum(["open", "waiting", "resolved", "canceled", "unchanged", "needs_resolution"]),
  diagnostic: z.string(),
});

export const ledgerSchema = z.object({
  version: z.literal(1),
  parentId: z.string(),
  revision: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  nextSequence: z.number().int().nonnegative().default(0),
  migrationVersion: z.number().int().nonnegative().default(0),
  events: z.array(eventSchema),
  tasks: z.array(taskSchema),
  memberships: z.array(membershipSchema),
  decisions: z.array(decisionSchema),
  commands: z.array(commandSchema),
  bindings: z.array(bindingSchema),
  commandIntents: z.array(commandIntentSchema).default([]),
  changes: z.array(lifecycleChangeSchema).default([]),
  lifecycleReviews: z.array(lifecycleReviewSchema).default([]),
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
    nextSequence: 0,
    migrationVersion: 0,
    events: [],
    tasks: [],
    memberships: [],
    decisions: [],
    commands: [],
    bindings: [],
    commandIntents: [],
    changes: [],
    lifecycleReviews: [],
    mode: "shadow",
  };
}

/** Keep shadow proposals separate from authoritative live and legacy tasks.
@param mode - Explicit ledger mode.
@param task - Task navigation value.
@returns Whether this task participates in the current authoritative view.
*/
export function isTaskAuthoritative(mode: Ledger["mode"], task: Task) {
  return mode === "shadow" || task.authority !== "proposal";
}
