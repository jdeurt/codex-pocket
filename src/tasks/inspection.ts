import type { Ledger, Task, TaskEvent } from "./model";
import { hasEventId, hasTaskId } from "./transitions";
import { taskDelivery } from "./context";
import { latestDecision } from "./reconciliation";

const SUMMARY_LENGTH = 300;

export interface TaskInspection {
  taskId?: string;
  eventId?: string;
  decisionId?: string;
  offset: number;
  limit: number;
}

/** Describe one task for bounded navigation without replacing its exact original intent.
@param state - Parent checkpoint.
@param task - Stored task.
@returns Small navigation record with an explicit detail identity.
*/
function taskNavigation(state: Ledger, task: Task) {
  return {
    id: task.id,
    revision: task.revision,
    title: task.title,
    authority: task.authority,
    work: task.work,
    retention: task.retention,
    delivery: taskDelivery(state, task).state,
    originalEventId: task.originalEventId,
    summary: task.summary.slice(0, SUMMARY_LENGTH),
    pendingQuestionCount: task.pendingQuestions.length,
  };
}

/** Keep source identities and original references visible in bounded inspection pages.
@param state - Parent checkpoint.
@param event - Stored event.
@returns Source preview with its latest explainable decision.
*/
function eventNavigation(state: Ledger, event: TaskEvent) {
  const decision = latestDecision(state, event.id);

  return {
    id: event.id,
    origin: event.origin,
    visibility: event.visibility,
    delivery: event.delivery,
    requestId: event.requestId,
    nativeEntryId: event.nativeEntryId,
    commandId: event.commandId,
    contentRefs: event.contentRefs,
    text: event.text.slice(0, SUMMARY_LENGTH),
    textOmitted: Math.max(0, event.text.length - SUMMARY_LENGTH),
    decisionId: decision?.id,
    decisionSource: decision?.source,
    assignment: decision?.assignment.kind,
  };
}

/** Select one task's event relationships without changing membership.
@param taskId - Task selected for inspection.
@param member - Stored membership.
@returns Membership equality.
*/
function isTaskMember(taskId: string, member: Ledger["memberships"][number]) {
  return member.taskId === taskId;
}

/** Inspect one original event with paged decision history.
@param state - Parent checkpoint.
@param eventId - Exact event identity.
@param offset - History offset.
@param limit - History page size.
@returns Exact selected event and its decision page.
*/
function inspectEvent(state: Ledger, eventId: string, offset: number, limit: number) {
  const event = state.events.find(hasEventId.bind(undefined, eventId));
  const decisions = [];
  const memberships = [];

  for (const decision of state.decisions) {
    if (decision.eventId === eventId) {
      decisions.push(decision);
    }
  }

  for (const member of state.memberships) {
    if (member.eventId === eventId) {
      memberships.push(member);
    }
  }

  return {
    revision: state.revision,
    event: event ?? null,
    memberships,
    decisions: decisions.slice(offset, offset + limit),
    totalDecisions: decisions.length,
  };
}

/** Select authoritative records by explicit identity or a bounded page, preserving parent scope.
@param state - Authorized parent's checkpoint.
@param input - Requested record or navigation page.
@returns Reviewable state and revision without dumping the entire ledger into a model context.
*/
export function inspectTaskLedger(state: Ledger, input: TaskInspection) {
  const { offset, limit } = input;

  if (input.decisionId) {
    let decision: Ledger["decisions"][number] | undefined;

    for (const candidate of state.decisions) {
      if (candidate.id === input.decisionId) {
        decision = candidate;
      }
    }

    return { revision: state.revision, decision: decision ?? null };
  }

  if (input.eventId) {
    return inspectEvent(state, input.eventId, offset, limit);
  }

  if (input.taskId) {
    const task = state.tasks.find(hasTaskId.bind(undefined, input.taskId));
    const members = state.memberships.filter(isTaskMember.bind(undefined, input.taskId));
    const events = [];

    const selected = members.slice(offset, offset + limit);

    for (const member of selected) {
      const event = state.events.find(hasEventId.bind(undefined, member.eventId));

      if (event) {
        events.push({ membership: member, source: eventNavigation(state, event) });
      }
    }

    return { revision: state.revision, task: task ?? null, events, totalMemberships: members.length };
  }

  const unresolved = [];

  for (const event of state.events) {
    if (latestDecision(state, event.id)?.assignment.kind === "unresolved") {
      unresolved.push(event);
    }
  }

  return {
    revision: state.revision,
    mode: state.mode,
    tasks: Array.from(state.tasks.slice(offset, offset + limit), taskNavigation.bind(undefined, state)),
    unresolved: Array.from(unresolved.slice(offset, offset + limit), eventNavigation.bind(undefined, state)),
    commands: state.commands.slice(offset, offset + limit),
    totals: { tasks: state.tasks.length, unresolved: unresolved.length, commands: state.commands.length },
    offset,
    limit,
  };
}
