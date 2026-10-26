import type { Ledger, Task, Membership, TaskOperation } from "./model";
import { assignEvent, hasEventId, hasTaskId } from "./transitions";
import { assignmentDecision, reconcileRoutes } from "./reconciliation";
import { validateResolution } from "./work-policy";

export { taskOperationSchema, type TaskOperation } from "./model";

/** Require a task from the authorized parent's checkpoint.
@param state - Current ledger.
@param taskId - Requested task identity.
@returns Existing task.
*/
function requireTask(state: Ledger, taskId: string) {
  const task = state.tasks.find(hasTaskId.bind(undefined, taskId));

  if (!task) {
    throw new Error("Task does not exist in this parent.");
  }

  return task;
}

/** Select one immutable updated task revision.
@param updated - Explicit changed task fields.
@param task - Prior task value.
@returns Updated revision for the selected task.
*/
function revisedTask(updated: Task, task: Task) {
  return task.id === updated.id ? { ...updated, revision: task.revision + 1 } : task;
}

/** Publish an immutable task revision while preserving its original intent.
@param state - Current checkpoint.
@param updated - Task with explicit changed fields.
@returns Next task set.
*/
function replaceTask(state: Ledger, updated: Task): Ledger {
  const tasks = Array.from(state.tasks, revisedTask.bind(undefined, updated));

  return { ...state, tasks };
}

/** Move membership using a superseding correction without editing source records.
@param state - Current ledger.
@param eventId - Event to repair.
@param taskIds - Explicit destinations.
@param rationale - Operator-supplied repair reason.
@returns Explainable replacement membership.
*/
function moveEvent(state: Ledger, eventId: string, taskIds: string[], rationale: string) {
  const decision = assignmentDecision(
    state,
    eventId,
    { kind: "attach", taskIds },
    "correction",
    "task-repair-v1",
    rationale
  );

  return assignEvent(state, decision);
}

/** Apply explicit per-task spans while keeping other spans from the same correction.
@param state - Current ledger.
@param operation - Explicit task destinations and original-text spans.
@param reason - Operator explanation.
@returns Repaired span membership.
*/
function moveSpans(state: Ledger, operation: Extract<TaskOperation, { kind: "move" }>, reason: string) {
  if (!operation.spans?.length) {
    return moveEvent(state, operation.eventId, operation.taskIds, reason);
  }

  let next = state;

  for (const span of operation.spans) {
    if (!operation.taskIds.includes(span.taskId)) {
      throw new Error("Content span task must be an explicit move destination.");
    }

    const decision = assignmentDecision(
      next,
      operation.eventId,
      { kind: "attach", taskIds: [span.taskId], span: { start: span.start, end: span.end } },
      "correction",
      "task-repair-v1",
      reason
    );
    const supersedes = next === state ? decision.supersedes : [];

    next = assignEvent(next, { ...decision, supersedes });
  }

  return next;
}

/** Change work state only with source evidence already associated with the task.
@param state - Current checkpoint.
@param operation - Explicit work-state change.
@returns Updated work state; completed model turns have no implicit effect.
*/
function changeWork(state: Ledger, operation: Extract<TaskOperation, { kind: "work" }>) {
  const task = requireTask(state, operation.taskId);

  for (const id of operation.evidence) {
    const hasSource = state.events.some(hasEventId.bind(undefined, id));

    let isMember = false;

    for (const member of state.memberships) {
      isMember ||= member.taskId === task.id && member.eventId === id;
    }

    if (!hasSource || !isMember) {
      throw new Error("Lifecycle evidence must reference an existing task member.");
    }
  }

  const priorQuestions = operation.work === "canceled" ? [] : task.pendingQuestions;
  const pendingQuestions = operation.pendingQuestions ?? priorQuestions;

  validateResolution(state, task, operation, pendingQuestions);

  return replaceTask(state, {
    ...task,
    work: operation.work,
    evidence: operation.evidence,
    summary: operation.summary ?? task.summary,
    pendingQuestions,
    retention: operation.work === "open" || operation.work === "waiting" ? "active" : task.retention,
  });
}

/** Replace associations while preserving explicit spans and superseding prior decisions once.
@param state - Current checkpoint.
@param eventId - Exact source.
@param destinations - Reviewed associations, including unchanged spans in other tasks.
@param reason - Repair explanation.
@returns Corrected membership.
*/
function replaceAssociations(
  state: Ledger,
  eventId: string,
  destinations: Pick<Membership, "taskId" | "span">[],
  reason: string
) {
  let next = state;

  const seen = new Set<string>();

  for (const destination of destinations) {
    const key = JSON.stringify(destination);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const decision = assignmentDecision(
      next,
      eventId,
      { kind: "attach", taskIds: [destination.taskId], span: destination.span },
      "correction",
      "task-repair-v1",
      reason
    );

    next = assignEvent(next, { ...decision, supersedes: next === state ? decision.supersedes : [] });
  }

  return next;
}

/** Split selected members into a distinct task, keeping the old task's original intent.
@param state - Current checkpoint.
@param operation - Explicit member selection and new task identity.
@param reason - Repair explanation.
@returns New task and superseding member assignments.
*/
function splitTask(state: Ledger, operation: Extract<TaskOperation, { kind: "split" }>, reason: string) {
  requireTask(state, operation.taskId);

  for (const eventId of operation.eventIds) {
    let isMember = false;

    for (const member of state.memberships) {
      isMember ||= member.taskId === operation.taskId && member.eventId === eventId;
    }

    if (!isMember) {
      throw new Error("Split selection includes an event outside the source task.");
    }
  }

  const first = operation.eventIds[0];
  const decision = assignmentDecision(
    state,
    first,
    { kind: "create", taskId: operation.newTaskId, title: operation.title },
    "correction",
    "task-repair-v1",
    reason
  );

  let next = assignEvent(state, decision);

  for (const eventId of operation.eventIds) {
    const destinations = [];

    for (const member of state.memberships) {
      if (member.eventId === eventId) {
        destinations.push({
          taskId: member.taskId === operation.taskId ? operation.newTaskId : member.taskId,
          span: member.span,
        });
      }
    }

    next = replaceAssociations(next, eventId, destinations, reason);
  }

  return next;
}

/** Merge membership into one task while retaining every task's original intent and work state.
@param state - Current checkpoint.
@param operation - Explicit source tasks and target.
@param reason - Repair explanation.
@returns Combined membership and archived source-task navigation.
*/
function mergeTasks(state: Ledger, operation: Extract<TaskOperation, { kind: "merge" }>, reason: string) {
  requireTask(state, operation.targetTaskId);
  const events = new Set<string>();

  let next = state;

  for (const taskId of operation.taskIds) {
    const task = requireTask(next, taskId);

    for (const member of state.memberships) {
      if (member.taskId === taskId) {
        events.add(member.eventId);
      }
    }

    if (taskId !== operation.targetTaskId) {
      next = replaceTask(next, { ...task, retention: "archived" });
    }
  }

  for (const eventId of events) {
    const destinations = [];

    for (const member of state.memberships) {
      if (member.eventId === eventId) {
        destinations.push({
          taskId: operation.taskIds.includes(member.taskId) ? operation.targetTaskId : member.taskId,
          span: member.span,
        });
      }
    }

    next = replaceAssociations(next, eventId, destinations, reason);
  }

  return next;
}

/** Apply centralized repair, work and retention operations with an immutable audit record.
@param operation - Validated explicit change.
@param reason - Bounded operator explanation.
@param state - Expected input checkpoint.
@returns Reconciled next state without modifying exact originals.
*/
export function applyTaskOperation(operation: TaskOperation, reason: string, state: Ledger): Ledger {
  if (!reason.trim()) {
    throw new Error("Task changes require an explanation.");
  }

  let next: Ledger;

  switch (operation.kind) {
    case "assign": {
      const decision = assignmentDecision(
        state,
        operation.eventId,
        operation.assignment,
        "correction",
        "task-repair-v1",
        reason
      );

      next = assignEvent(state, decision);
      break;
    }

    case "work": {
      next = changeWork(state, operation);
      break;
    }

    case "retain": {
      const task = requireTask(state, operation.taskId);

      next = replaceTask(state, { ...task, retention: operation.retention });
      break;
    }

    case "move": {
      next = moveSpans(state, operation, reason);
      break;
    }

    case "split": {
      next = splitTask(state, operation, reason);
      break;
    }

    case "merge": {
      next = mergeTasks(state, operation, reason);
      break;
    }
  }

  const change = { id: `change:${String(state.changes.length)}`, inputRevision: state.revision, operation, reason };

  return reconcileRoutes({ ...next, changes: [...state.changes, change] });
}
