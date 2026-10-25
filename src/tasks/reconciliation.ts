import type { Assignment, Decision, Ledger, TaskEvent } from "./model";
import { assignEvent } from "./transitions";
import { routeEvent, ROUTING_VERSION } from "./routing";

/** Describe a bounded, reproducible assignment against explicit event and task revisions.
@param state - Expected input checkpoint.
@param eventId - Source event.
@param assignment - Proposed membership or diagnostic.
@param source - Decision mechanism.
@param version - Policy or provider version.
@param rationale - Bounded explanation.
@param confidence - Provider confidence, or null when not calibrated.
@returns Explainable decision with superseding history.
*/
export function assignmentDecision(
  state: Ledger,
  eventId: string,
  assignment: Assignment,
  source: Decision["source"],
  version: string,
  rationale: string,
  confidence: number | null = null
): Decision {
  const taskRevisions: Record<string, number> = {};
  const supersedes: string[] = [];

  for (const task of state.tasks) {
    taskRevisions[task.id] = task.revision;
  }

  for (const prior of state.decisions) {
    if (prior.eventId === eventId) {
      supersedes.push(prior.id);
    }
  }

  return {
    id: `${eventId}:decision:${String(state.decisions.length)}`,
    eventId,
    source,
    version,
    inputRevision: state.revision,
    taskRevisions,
    confidence,
    rationale,
    assignment,
    supersedes,
  };
}

/** Select the most recent assignment for a source event.
@param state - Ledger containing immutable decision history.
@param eventId - Input identity.
@returns Latest decision when available.
*/
export function latestDecision(state: Ledger, eventId: string) {
  let latest: Decision | undefined;

  for (const decision of state.decisions) {
    if (decision.eventId === eventId) {
      latest = decision;
    }
  }

  return latest;
}

/** Resolve newly available causal links, including reports that arrived before semantic assignment.
@param initial - Current checkpoint.
@returns Deterministic assignments without invoking a classifier.
*/
export function reconcileRoutes(initial: Ledger) {
  let state = initial;

  // A second pass can propagate a relationship through a later-arriving parent event.
  for (let pass = 0; pass <= state.events.length; pass++) {
    let isChanged = false;

    for (const event of state.events) {
      const prior = latestDecision(state, event.id);

      if (prior && ["classification", "legacy", "correction"].includes(prior.source)) {
        continue;
      }

      const assignment = routeEvent(state, event);

      if (!assignment || JSON.stringify(prior?.assignment) === JSON.stringify(assignment)) {
        continue;
      }

      const source = assignment.kind === "attach" ? "correlation" : "policy";
      const decision = assignmentDecision(
        state,
        event.id,
        assignment,
        source,
        ROUTING_VERSION,
        assignment.kind === "unresolved" ? assignment.diagnostic : "Recorded application relationship or origin policy."
      );

      state = assignEvent(state, decision);
      isChanged = true;
    }

    if (!isChanged) {
      break;
    }
  }

  return state;
}

/** Collect originating requests through native causal relationships, without task classification.
@param state - Ledger.
@param event - Causally owned native event.
@param seen - Cycle guard.
@returns Explicit originating request identities.
*/
export function originatingRequests(state: Ledger, event: TaskEvent, seen: readonly string[] = []): string[] {
  const visited = new Set(seen);

  let current: TaskEvent | undefined = event;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);

    if (current.requestId) {
      return [current.requestId];
    }

    let parent: TaskEvent | undefined;

    for (const candidate of state.events) {
      if (candidate.id === current.causedBy) {
        parent = candidate;
      }
    }

    current = parent;
  }

  return [];
}
