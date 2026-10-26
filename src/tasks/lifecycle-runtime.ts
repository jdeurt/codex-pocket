import { t } from "try";
import { valueAfterCleanup } from "../lib/results";
import { TaskRepository } from "./repository";
import { readTaskSources } from "./sources";
import { commandTaskIds } from "./routing";
import { readCommandEvidence } from "./command-evidence";
import { lifecycleInput, lifecycleInputHash } from "./lifecycle-evidence";
import { classifyTaskLifecycle } from "./lifecycle-classifier";
import { areCommandsSettled, assessedLifecycleCheckpoint, answeredQuestionCheckpoint } from "./lifecycle-assessment";
import { retainTaskContext } from "./retention";
import type { Ledger } from "./model";
import { latestDecision } from "./reconciliation";

/** Detect an incoming request that has not yet completed intent interpretation.
@param state - Current parent checkpoint.
@returns Whether lifecycle assessment must wait for membership interpretation.
*/
function hasUnclassifiedIntent(state: Ledger) {
  for (const event of state.events) {
    if (["typed", "voice_request", "scheduled"].includes(event.origin) && !latestDecision(state, event.id)) {
      return true;
    }
  }

  return false;
}

/** Select per-command relationships for one task, preserving reused delegate isolation.
@param state - Expected checkpoint.
@param taskId - Task under review.
@param command - Recorded assignment.
@returns Whether this command's recorded requests establish membership.
*/
function isTaskCommand(state: Ledger, taskId: string, command: Ledger["commands"][number]) {
  return commandTaskIds(state, command).includes(taskId);
}

/** Run dedicated lifecycle assessment without holding database locks across provider requests.
@param repository - Owned parent ledger.
@param apiKey - Current provider credential.
@param isMainTurnActive - Runtime observation; active main work cannot be declared complete.
@param signal - New-input and shutdown preemption boundary.
@returns Committed assessments and independent context-retention decisions.
*/
async function reviewLifecycle(
  repository: TaskRepository,
  apiKey: string,
  isMainTurnActive: boolean,
  signal?: AbortSignal
) {
  const sources = await readTaskSources(repository.parentId);

  let state = repository.read();

  if (hasUnclassifiedIntent(state)) {
    return state;
  }

  for (const task of state.tasks) {
    signal?.throwIfAborted();
    const commands = state.commands.filter(isTaskCommand.bind(undefined, state, task.id));
    const facts = readCommandEvidence(state.parentId, commands);
    const input = lifecycleInput(state, task, sources, facts, isMainTurnActive);

    if (!input) {
      continue;
    }

    const hash = lifecycleInputHash(input);

    let isReviewed = false;

    for (const prior of state.lifecycleReviews) {
      isReviewed ||= prior.taskId === task.id && prior.inputHash === hash;
    }

    if (isReviewed) {
      continue;
    }

    if (isMainTurnActive && input.pendingQuestions.length === 0) {
      state = repository.commit(answeredQuestionCheckpoint(state, task, input), "Reconcile actual phone answers");

      continue;
    }

    const isKnownWaiting = input.pendingQuestions.length > 0 || (!isMainTurnActive && !areCommandsSettled(input));
    const probabilities = isKnownWaiting
      ? new Map<string, number>()
      : await classifyTaskLifecycle(apiKey, signal, input, state.parentId);

    signal?.throwIfAborted();
    const currentFacts = readCommandEvidence(state.parentId, commands);

    if (repository.read().revision !== state.revision || JSON.stringify(facts) !== JSON.stringify(currentFacts)) {
      return repository.read();
    }

    state = repository.commit(
      assessedLifecycleCheckpoint(state, task, input, hash, probabilities),
      "Assess task lifecycle against exact source and command revisions"
    );
  }

  const facts = readCommandEvidence(state.parentId, state.commands);

  return repository.commit(retainTaskContext(state, facts), "Apply independent task context-retention policy");
}

/** Own lifecycle review and native database cleanup for one evidence-driven background pass.
@param parentId - Authorized parent.
@param apiKey - Server-only provider credential.
@param isMainTurnActive - Runtime execution state, never inferred from prose.
@param signal - Optional new-input cancellation.
@returns Authoritative checkpoint; stale assessments are discarded.
*/
export async function reviewTaskLifecycle(
  parentId: string,
  apiKey: string,
  isMainTurnActive: boolean,
  signal?: AbortSignal
) {
  const repository = new TaskRepository(parentId);
  const result = await t(reviewLifecycle, repository, apiKey, isMainTurnActive, signal);
  const closed = t(repository.close.bind(repository));

  return valueAfterCleanup(result, closed);
}
