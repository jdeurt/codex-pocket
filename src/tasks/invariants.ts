import type { Ledger } from "./model";

/** Reject duplicate identities in authoritative record collections.
@param identities - Explicit record identities.
@param name - Collection label for diagnostics.
*/
function assertUnique(identities: string[], name: string) {
  if (new Set(identities).size !== identities.length) {
    throw new Error(`Duplicate ${name} identities in task ledger.`);
  }
}

/** Select a stable record identity.
@param record - Identified ledger record.
@returns Original identity.
*/
function recordId(record: { id: string }) {
  return record.id;
}

/** Require every previous event to remain unchanged.
@param current - Durable state.
@param next - Proposed state.
*/
function assertOriginalEvents(current: Ledger, next: Ledger) {
  for (const event of current.events) {
    let isPreserved = false;

    for (const candidate of next.events) {
      isPreserved ||= event.id === candidate.id && JSON.stringify(event) === JSON.stringify(candidate);
    }

    if (!isPreserved) {
      throw new Error("Original task events are immutable; append a correction.");
    }
  }
}

/** Require stable task identity and original intent across repairs.
@param current - Durable state.
@param next - Proposed state.
*/
function assertOriginalTasks(current: Ledger, next: Ledger) {
  for (const task of current.tasks) {
    let isPreserved = false;

    for (const candidate of next.tasks) {
      isPreserved ||=
        task.id === candidate.id &&
        task.originalEventId === candidate.originalEventId &&
        task.originalIntent === candidate.originalIntent &&
        candidate.revision >= task.revision;
    }

    if (!isPreserved) {
      throw new Error("Original task intent and identity are immutable.");
    }
  }
}

/** Validate every membership reference before committing.
@param state - Proposed ledger.
*/
function assertMemberships(state: Ledger) {
  const events = new Set(Array.from(state.events, recordId));
  const tasks = new Set(Array.from(state.tasks, recordId));
  const decisions = new Map<string, string>();

  for (const decision of state.decisions) {
    decisions.set(decision.id, decision.eventId);
  }

  for (const member of state.memberships) {
    if (
      !events.has(member.eventId) ||
      !tasks.has(member.taskId) ||
      decisions.get(member.decisionId) !== member.eventId
    ) {
      throw new Error("Task membership has a missing event, task or decision.");
    }
  }
}

/** Enforce append-only evidence, stable original intent, and referential membership integrity.
@param current - Committed checkpoint.
@param next - Proposed replacement.
*/
export function assertLedgerTransition(current: Ledger, next: Ledger) {
  assertUnique(Array.from(next.events, recordId), "event");
  assertUnique(Array.from(next.tasks, recordId), "task");
  assertUnique(Array.from(next.decisions, recordId), "decision");
  assertUnique(Array.from(next.commands, recordId), "command");
  assertOriginalEvents(current, next);
  assertOriginalTasks(current, next);
  assertMemberships(next);
  const prefix = next.decisions.slice(0, current.decisions.length);
  const changes = next.changes.slice(0, current.changes.length);

  if (
    JSON.stringify(prefix) !== JSON.stringify(current.decisions) ||
    JSON.stringify(changes) !== JSON.stringify(current.changes)
  ) {
    throw new Error("Task decision and lifecycle history is append-only.");
  }
}
