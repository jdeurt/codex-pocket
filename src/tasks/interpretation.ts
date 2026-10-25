import type { Assignment, Ledger, TaskEvent } from "./model";

const ACCEPT_THRESHOLD = 0.8;
const REJECT_THRESHOLD = 0.2;
const TITLE_LENGTH = 160;
export const CLASSIFIER_VERSION = "bounded-intent-v1";

export interface IntentEvidence {
  actionable: number;
  independent: number;
  cancel: number;
  correction: number;
  matches: { taskId: string; probability: number }[];
}

/** Interpret bounded semantic evidence without forcing an ambiguous task assignment.
@param state - Input ledger and candidate task revisions.
@param event - Current request, excluding historical voice context.
@param evidence - Validated provider probabilities.
@param generatedTaskId - Runtime-generated identity used only for a new task.
@returns Semantic assignment with explicit ambiguity preserved.
*/
export function interpretTaskIntent(
  state: Ledger,
  event: TaskEvent,
  evidence: IntentEvidence,
  generatedTaskId: string
): Assignment {
  if (!event.text.trim()) {
    return {
      kind: "unresolved",
      diagnostic: "Current observed intent is missing; historical context is not a request.",
    };
  }

  const matches: string[] = [];

  let hasAmbiguousMatch = false;

  for (const candidate of evidence.matches) {
    if (candidate.probability >= ACCEPT_THRESHOLD) {
      matches.push(candidate.taskId);
    } else if (candidate.probability > REJECT_THRESHOLD) {
      hasAmbiguousMatch = true;
    }
  }

  if (!hasAmbiguousMatch && matches.length === 1) {
    return { kind: "attach", taskIds: matches };
  }

  if (matches.length > 1) {
    return { kind: "unresolved", diagnostic: "Request discusses multiple tasks; resolve explicit content spans." };
  }

  if (hasAmbiguousMatch || (evidence.actionable > REJECT_THRESHOLD && evidence.actionable < ACCEPT_THRESHOLD)) {
    return { kind: "unresolved", diagnostic: "Task intent or membership is ambiguous." };
  }

  if (evidence.actionable <= REJECT_THRESHOLD) {
    return { kind: "conversation" };
  }

  if (evidence.independent >= ACCEPT_THRESHOLD && evidence.cancel < ACCEPT_THRESHOLD) {
    return { kind: "create", taskId: generatedTaskId, title: event.text.slice(0, TITLE_LENGTH) };
  }

  return {
    kind: "unresolved",
    diagnostic:
      state.tasks.length > 0
        ? "A continuation or cancellation has no established task target."
        : "The request does not establish an independent task.",
  };
}

/** Describe supported lifecycle consequences of an explicit correction or cancellation.
@param evidence - Provider's validated interpretation.
@returns Explicit user-intent transition, or null when no lifecycle claim is supported.
*/
export function interpretedWorkChange(evidence: IntentEvidence) {
  if (evidence.cancel >= ACCEPT_THRESHOLD) {
    return "canceled" as const;
  }

  return evidence.correction >= ACCEPT_THRESHOLD ? ("open" as const) : null;
}
