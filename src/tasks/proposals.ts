import { readTaskLedger } from "./management";
import { hasEventId } from "./transitions";
import { classifyTaskIntent } from "./intent-classifier";
import { interpretTaskIntent, CLASSIFIER_VERSION } from "./interpretation";
import { assignmentDecision } from "./reconciliation";

/** Produce a reviewable historical reclassification proposal without committing membership or replaying work.
@param parentId - Authorized parent.
@param eventId - Exact request event selected for review.
@param apiKey - Central credential resolved by the effectful caller.
@returns Concrete proposed assignment, input revision and probabilities; applying it is a separate reviewed operation.
*/
export async function proposeTaskAssignment(parentId: string, eventId: string, apiKey: string) {
  const state = readTaskLedger(parentId);
  const event = state.events.find(hasEventId.bind(undefined, eventId));

  if (!event?.text.trim()) {
    throw new Error("Select a request event with known current intent; missing historical provenance remains unknown.");
  }

  const evidence = await classifyTaskIntent(apiKey, undefined, state, event);
  const assignment = interpretTaskIntent(state, event, evidence, crypto.randomUUID());
  const decision = assignmentDecision(
    state,
    event.id,
    assignment,
    "classification",
    CLASSIFIER_VERSION,
    "Historical review proposal only. No task membership or source record has been changed."
  );

  return {
    expectedRevision: state.revision,
    decision,
    evidence,
    applied: false,
    operation: { kind: "assign" as const, eventId: event.id, assignment },
  };
}
