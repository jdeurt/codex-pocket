import { t } from "try";
import { TASK_CLASSIFIERS } from "./classifier-definitions";
import type { Ledger, Task, TaskOperation } from "./model";
import { applyTaskOperation } from "./lifecycle";
import type { LifecycleInput } from "./lifecycle-evidence";

type WorkChange = Extract<TaskOperation, { kind: "work" }>;

/** Read an exact validated predicate without introducing implicit positive evidence.
@param probabilities - Provider response, or an empty map for application-owned waiting facts.
@param name - Shared predicate name.
@returns Supported confidence, defaulting to no claim.
*/
function confidence(probabilities: ReadonlyMap<string, number>, name: string) {
  return probabilities.get(name) ?? 0;
}

/** Select exact supporting source identities; truncated previews cannot establish completion.
@param input - Bounded evidence packet.
@param probabilities - Exact requested evidence predicates.
@returns Source identities explicitly supported by the assessment.
*/
function supportingEvents(input: LifecycleInput, probabilities: ReadonlyMap<string, number>) {
  const ids: string[] = [];

  for (const [index, event] of input.events.entries()) {
    const name = `${TASK_CLASSIFIERS.lifecycle.evidencePrefix}${String(index)}`;

    if (!event.truncated && confidence(probabilities, name) >= TASK_CLASSIFIERS.accept) {
      ids.push(event.eventId);
    }
  }

  return ids;
}

/** Combine recorded native questions with classifier-selected delivered questions and supported answers.
@param input - Current source and pending-question evidence.
@param probabilities - Dedicated question predicates.
@returns Outstanding exact question text and its recorded supporting sources.
*/
function pendingAssessment(input: LifecycleInput, probabilities: ReadonlyMap<string, number>) {
  const questions = new Set<string>();
  const sources = new Set<string>();

  for (const [index, question] of input.task.pendingQuestions.entries()) {
    const name = `${TASK_CLASSIFIERS.lifecycle.answeredQuestionPrefix}${String(index)}`;

    if (confidence(probabilities, name) < TASK_CLASSIFIERS.accept) {
      questions.add(question);
    }
  }

  for (const pending of input.pendingQuestions) {
    questions.add(pending.question);
    sources.add(pending.eventId);
  }

  for (const [index, event] of input.events.entries()) {
    const name = `${TASK_CLASSIFIERS.lifecycle.pendingQuestionPrefix}${String(index)}`;

    if (
      event.truncated ||
      event.origin !== "assistant" ||
      event.delivery !== "delivered" ||
      !event.text.trim() ||
      confidence(probabilities, name) < TASK_CLASSIFIERS.accept
    ) {
      continue;
    }

    questions.add(event.text);
    sources.add(event.eventId);
  }

  return { questions: [...questions], sources: [...sources] };
}

/** Distinguish settled execution from active or uncertain command dependencies.
@param input - Application-owned command facts.
@returns Whether every recorded assignment has a known terminal execution outcome; success is assessed separately.
*/
export function areCommandsSettled(input: Pick<LifecycleInput, "commands">) {
  for (const command of input.commands) {
    if (!command.isSettled) {
      return false;
    }
  }

  return true;
}

/** Require a settled main turn, complete intent and an unambiguous delivery requirement for resolution.
@param base - Exact task and supporting evidence identities.
@param input - Source evidence packet.
@param probabilities - Dedicated assessment probabilities.
@returns Resolution proposal or null while work or evidence remains unsettled.
*/
function resolvedWork(
  base: Omit<WorkChange, "work">,
  input: LifecycleInput,
  probabilities: ReadonlyMap<string, number>
): WorkChange | null {
  const delivery = confidence(probabilities, "delivery_required");
  const isAmbiguous = delivery > TASK_CLASSIFIERS.reject && delivery < TASK_CLASSIFIERS.accept;

  let hasIncompleteIntent = input.task.intentTruncated || input.omittedRequests > 0 || input.omittedQuestions > 0;

  for (const request of input.requests) {
    hasIncompleteIntent ||= request.truncated;
  }

  if (isAmbiguous || hasIncompleteIntent || input.isMainTurnActive) {
    return null;
  }

  let basis: NonNullable<WorkChange["resolution"]>["basis"] = "result";

  if (confidence(probabilities, "user_confirmed") >= TASK_CLASSIFIERS.accept) {
    basis = "user_confirmation";
  } else if (confidence(probabilities, "answer_satisfies_request") >= TASK_CLASSIFIERS.accept) {
    basis = "delivered_answer";
  }

  return {
    ...base,
    work: "resolved",
    summary: "Requested work verified against recorded evidence.",
    resolution: {
      basis,
      verification: "Dedicated lifecycle classification assessed the current request and cited exact results.",
      deliveryRequired: delivery >= TASK_CLASSIFIERS.accept,
    },
  };
}

/** Describe an evidence-backed lifecycle assessment without executing a state change.
@param task - Current task.
@param input - Current source evidence.
@param probabilities - Dedicated classifier output.
@returns Concrete transition or null when evidence is insufficient or ambiguous.
*/
function assessedWork(
  task: Task,
  input: LifecycleInput,
  probabilities: ReadonlyMap<string, number>
): WorkChange | null {
  const evidence = supportingEvents(input, probabilities);
  const pending = pendingAssessment(input, probabilities);
  const questions = pending.questions;

  const base = { kind: "work" as const, taskId: task.id, evidence, pendingQuestions: questions };

  if (questions.length > 0 && task.work !== "canceled") {
    const sources = pending.sources.length > 0 ? pending.sources : [input.latestRequestId];

    return { ...base, work: "waiting", evidence: sources, summary: "Waiting for user answers." };
  }

  if (!input.isMainTurnActive && !areCommandsSettled(input) && task.work !== "canceled") {
    return { ...base, work: "waiting", evidence: [input.latestRequestId], summary: "Waiting for delegate work." };
  }

  const accepted: string[] = [];

  for (const name of ["resolved", "waiting", "canceled", "reopen"]) {
    const value = confidence(probabilities, name);

    if (value > TASK_CLASSIFIERS.reject && value < TASK_CLASSIFIERS.accept) {
      return null;
    }

    if (value >= TASK_CLASSIFIERS.accept) {
      accepted.push(name);
    }
  }

  if (accepted.length !== 1 || evidence.length === 0) {
    return null;
  }

  switch (accepted[0]) {
    case "canceled": {
      return { ...base, work: "canceled", summary: "Canceled by the user." };
    }

    case "reopen": {
      return { ...base, work: "open", summary: "Further authorized work is required." };
    }

    case "waiting": {
      return { ...base, work: "waiting", summary: "Waiting for a recorded dependency." };
    }

    default: {
      return resolvedWork(base, input, probabilities);
    }
  }
}

/** Retire a recorded phone question only when its exact awaited call produced a successful answer.
@param state - Expected checkpoint.
@param task - Previous task state.
@param input - Application-owned question and answer identities.
@returns Answered question state, independently of whether semantic completion is supported.
*/
export function answeredQuestionCheckpoint(state: Ledger, task: Task, input: LifecycleInput) {
  if (["resolved", "canceled"].includes(task.work) || input.omittedQuestions > 0) {
    return state;
  }

  const evidence: string[] = [];

  for (const answer of input.answeredQuestions) {
    if (task.evidence.includes(answer.questionEventId) && task.pendingQuestions.includes(answer.question)) {
      evidence.push(answer.eventId);
    }
  }

  if (evidence.length === 0) {
    return state;
  }

  const work = task.work === "waiting" && input.task.pendingQuestions.length === 0 ? "open" : task.work;

  return applyTaskOperation(
    {
      kind: "work",
      taskId: task.id,
      work,
      evidence,
      pendingQuestions: input.task.pendingQuestions,
      summary: work === "open" ? "User question answered; authorized work remains open." : task.summary,
    },
    TASK_CLASSIFIERS.lifecycle.dependencyVersion + ": reconcile actual phone answers.",
    state
  );
}

/** Commit assessment metadata and supported work changes together against the expected source checkpoint.
@param state - Exact input checkpoint.
@param task - Reviewed task revision.
@param input - Bounded source evidence.
@param inputHash - Stable evidence fingerprint.
@param probabilities - Dedicated classifier probabilities; empty for known application dependencies.
@returns Auditable proposed checkpoint; failed evidence guards preserve the prior work state.
*/
export function assessedLifecycleCheckpoint(
  state: Ledger,
  task: Task,
  input: LifecycleInput,
  inputHash: string,
  probabilities: ReadonlyMap<string, number>
) {
  const operation = assessedWork(task, input, probabilities);
  const review: Ledger["lifecycleReviews"][number] = {
    taskId: task.id,
    source: probabilities.size === 0 ? "policy" : "classification",
    requestEventId: input.latestRequestId,
    inputEvents: [],
    requestEvents: [],
    isMainTurnActive: input.isMainTurnActive,
    inputHash,
    version:
      probabilities.size === 0 ? TASK_CLASSIFIERS.lifecycle.dependencyVersion : TASK_CLASSIFIERS.lifecycle.version,
    inputRevision: state.revision,
    taskRevision: task.revision,
    probabilities: Object.fromEntries(probabilities),
    evidence: operation?.evidence ?? [],
    outcome: "needs_resolution",
    diagnostic: "Lifecycle evidence is incomplete or ambiguous; prior work state retained.",
  };

  for (const event of input.events) {
    review.inputEvents.push(event.eventId);
  }

  for (const request of input.requests) {
    review.requestEvents.push(request.eventId);
  }

  let next = answeredQuestionCheckpoint(state, task, input);

  if (operation) {
    const applied = t(applyTaskOperation, operation, "Dedicated task lifecycle assessment.", next);

    if (applied.ok) {
      next = applied.value;
      review.outcome = operation.work;
      review.diagnostic = "Applied evidence-backed lifecycle transition.";
    } else {
      review.diagnostic = String(applied.error);
    }
  }

  return { ...next, lifecycleReviews: [...next.lifecycleReviews, review] };
}
