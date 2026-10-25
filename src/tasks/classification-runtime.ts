import { t } from "try";
import { valueAfterCleanup } from "../lib/results";
import { TaskRepository } from "./repository";
import { classifyTaskIntent } from "./intent-classifier";
import { routeEvent } from "./routing";
import { assignmentDecision, latestDecision, reconcileRoutes } from "./reconciliation";
import { assignEvent } from "./transitions";
import { interpretTaskIntent, interpretedWorkChange, CLASSIFIER_VERSION, type IntentEvidence } from "./interpretation";
import { applyTaskOperation } from "./lifecycle";
import type { Assignment, Ledger, TaskEvent } from "./model";

/** Retain the provider probability supporting the selected assignment.
@param assignment - Selected semantic outcome.
@param evidence - Original provider probabilities; these are not calibrated accuracy claims.
@returns Supporting confidence, or null for unresolved intent.
*/
function semanticConfidence(assignment: Assignment, evidence: IntentEvidence) {
  if (assignment.kind === "unresolved") {
    return null;
  }

  if (assignment.kind === "create") {
    return Math.min(evidence.actionable, evidence.independent);
  }

  if (assignment.kind === "conversation") {
    return 1 - evidence.actionable;
  }

  const probabilities = [];

  for (const match of evidence.matches) {
    if (assignment.taskIds.includes(match.taskId)) {
      probabilities.push(match.probability);
    }
  }

  return Math.min(...probabilities, 1);
}

/** Commit a semantic proposal only when the ledger still has its exact expected revision.
@param state - Snapshot supplied to the classifier.
@param event - Current request.
@param evidence - Provider interpretation.
@param taskId - Runtime-generated identity for an independent request.
@returns Reconciled proposed checkpoint.
*/
export function classifiedCheckpoint(state: Ledger, event: TaskEvent, evidence: IntentEvidence, taskId: string) {
  if (routeEvent(state, event) !== null) {
    throw new Error("Known application relationships must be routed before classification.");
  }

  const assignment = interpretTaskIntent(state, event, evidence, taskId);
  const confidence = semanticConfidence(assignment, evidence);
  const decision = assignmentDecision(
    state,
    event.id,
    assignment,
    "classification",
    CLASSIFIER_VERSION,
    assignment.kind === "unresolved" ? assignment.diagnostic : "Bounded current intent and stable task descriptions.",
    assignment.kind === "unresolved" ? null : confidence
  );

  let next = assignEvent(state, decision);

  const work = interpretedWorkChange(evidence);

  if (work && assignment.kind === "attach" && assignment.taskIds.length === 1) {
    next = applyTaskOperation(
      { kind: "work", taskId: assignment.taskIds[0], work, evidence: [event.id] },
      "Classifier interpreted an explicit user correction or cancellation.",
      next
    );
  }

  return reconcileRoutes(next);
}

/** Run semantic interpretation without holding the persistence lock over network I/O.
@param repository - Parent ledger owner.
@param apiKey - Current provider credential.
@param signal - Input-preemption boundary.
@returns Updated checkpoint; stale results stop the pass and remain eligible for reconsideration.
*/
async function classifyPending(repository: TaskRepository, apiKey: string, signal?: AbortSignal) {
  let state = repository.read();

  for (const event of state.events) {
    signal?.throwIfAborted();
    const prior = latestDecision(state, event.id);

    if (prior || routeEvent(state, event) !== null) {
      continue;
    }

    const evidence = await classifyTaskIntent(apiKey, signal, state, event);

    signal?.throwIfAborted();

    if (repository.read().revision !== state.revision) {
      return repository.read();
    }

    state = repository.commit(
      classifiedCheckpoint(state, event, evidence, crypto.randomUUID()),
      "Classify current intent against expected task revisions"
    );
  }

  return state;
}

/** Own classification and native database cleanup for one background pass.
@param parentId - Authorized parent.
@param apiKey - Current central credential.
@param signal - Optional preemption by new input.
@returns Durable checkpoint, preserving unresolved work on provider failures.
*/
export async function classifyTaskLedger(parentId: string, apiKey: string, signal?: AbortSignal) {
  const repository = new TaskRepository(parentId);
  const result = await t(classifyPending, repository, apiKey, signal);
  const closed = t(repository.close.bind(repository));

  return valueAfterCleanup(result, closed);
}
