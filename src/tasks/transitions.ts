import { eventSchema, type Decision, type Ledger, type TaskEvent, type Membership } from "./model";

/** Match an event by its immutable identity.
@param id - Event identity.
@param event - Candidate event.
@returns Identity equality.
*/
export function hasEventId(id: string, event: TaskEvent) {
  return event.id === id;
}

/** Match a task identity without captured state.
@param id - Requested task.
@param task - Candidate task.
@returns Identity equality.
*/
export function hasTaskId(id: string, task: Ledger["tasks"][number]) {
  return task.id === id;
}

/** Record one immutable event, rejecting identity reuse with changed content or provenance.
@param state - Current ledger.
@param event - Application-authored event.
@returns New ledger, or the original checkpoint for an identical retry.
*/
export function recordEvent(state: Ledger, event: TaskEvent): Ledger {
  if (event.parentId !== state.parentId) {
    throw new Error("Task event belongs to another parent.");
  }

  const canonical = eventSchema.parse(event);
  const prior = state.events.find(hasEventId.bind(undefined, event.id));

  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(canonical)) {
      throw new Error("Task event identity already has different content or provenance.");
    }

    return state;
  }

  return { ...state, events: [...state.events, canonical] };
}

/** Apply one explainable assignment against its exact input revision.
@param state - Current ledger.
@param decision - Validated policy or classifier output.
@returns Next membership, tasks and decision history, without changing original events.
*/
export function assignEvent(state: Ledger, decision: Decision): Ledger {
  if (decision.inputRevision !== state.revision) {
    throw new Error("Stale task assignment; reconsider against the current revision.");
  }

  const event = state.events.find(hasEventId.bind(undefined, decision.eventId));

  if (!event) {
    throw new Error("Task assignment source is missing.");
  }

  const assignment = decision.assignment;
  const tasks = [...state.tasks];
  const memberships: Membership[] = [];

  if (assignment.kind === "create") {
    if (tasks.some(hasTaskId.bind(undefined, assignment.taskId))) {
      throw new Error("Task identity already exists.");
    }

    tasks.push({
      authority: state.mode === "shadow" ? "proposal" : "live",
      id: assignment.taskId,
      revision: 0,
      title: assignment.title,
      originalEventId: event.id,
      originalIntent: event.text,
      summary: event.text,
      work: "open",
      retention: "active",
      pendingQuestions: [],
      evidence: [],
    });
    memberships.push({ eventId: event.id, taskId: assignment.taskId, decisionId: decision.id });
  } else if (assignment.kind === "attach") {
    if (assignment.span && (assignment.span.start >= assignment.span.end || assignment.span.end > event.text.length)) {
      throw new Error("Task content span is outside the original request.");
    }

    for (const taskId of assignment.taskIds) {
      const task = tasks.find(hasTaskId.bind(undefined, taskId));

      if (decision.taskRevisions[taskId] !== task?.revision) {
        throw new Error("Task assignment references a missing or stale task revision.");
      }

      memberships.push({ eventId: event.id, taskId, span: assignment.span, decisionId: decision.id });
    }
  }

  const retained: Membership[] = [];
  const changedTaskIds = new Set<string>();

  for (const member of memberships) {
    changedTaskIds.add(member.taskId);
  }

  for (const member of state.memberships) {
    if (decision.supersedes.includes(member.decisionId)) {
      changedTaskIds.add(member.taskId);
    } else {
      retained.push(member);
    }
  }

  const revisedTasks = Array.from(tasks, (task) =>
    changedTaskIds.has(task.id) ? { ...task, revision: task.revision + 1 } : task
  );

  return {
    ...state,
    tasks: revisedTasks,
    memberships: [...retained, ...memberships],
    decisions: [...state.decisions, decision],
  };
}
