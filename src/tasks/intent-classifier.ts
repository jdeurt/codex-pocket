import type { TaskEvent, Ledger } from "./model";
import { taskDescriptions } from "./context";
import type { IntentEvidence } from "./interpretation";
import { TASK_CLASSIFIERS, type ClassifierQuestion } from "./classifier-definitions";
import { classifyPredicates } from "./classifier-client";

/** Associate a validated predicate with its stable task identity.
@param probabilities - Exact requested provider probabilities.
@param task - Task description.
@param index - Predicate index.
@returns Task-specific semantic evidence.
*/
function matchedEvidence(probabilities: ReadonlyMap<string, number>, task: { id: string }, index: number) {
  const name = `${TASK_CLASSIFIERS.intent.taskPrefix}${String(index)}`;

  return { taskId: task.id, probability: probabilities.get(name) ?? 0 };
}

/** Interpret current intent using the shared classifier definitions and bounded stable task descriptions.
@param apiKey - Server-only key.
@param signal - Cancellation when new input arrives.
@param state - Explicit expected input revision.
@param event - Current observed request.
@returns Validated semantic evidence; assignment and persistence remain separate.
*/
export async function classifyTaskIntent(
  apiKey: string,
  signal: AbortSignal | undefined,
  state: Ledger,
  event: TaskEvent
): Promise<IntentEvidence> {
  const tasks = taskDescriptions(state);
  const definition = TASK_CLASSIFIERS.intent;

  if (tasks.length > definition.maxTasks || event.text.length > definition.maxRequestLength) {
    throw new Error("Intent exceeds the bounded classifier input; narrow task references or resolve content spans.");
  }

  const questions: ClassifierQuestion[] = [...definition.questions];

  for (const [index, task] of tasks.entries()) {
    questions.push({
      type: "predicate",
      name: `${definition.taskPrefix}${String(index)}`,
      instructions: `${definition.taskPredicate} Named task: ${JSON.stringify(task.id)}.`,
    });
  }

  const probabilities = await classifyPredicates(
    apiKey,
    signal,
    { current_request: event.text, relevant_references: event.references ?? [], tasks },
    questions,
    { parentId: state.parentId, feature: "task_intent", provider: "openai", model: TASK_CLASSIFIERS.model }
  );
  const matches = Array.from(tasks, matchedEvidence.bind(undefined, probabilities));

  return {
    actionable: probabilities.get("actionable") ?? 0,
    independent: probabilities.get("independent") ?? 0,
    cancel: probabilities.get("cancel") ?? 0,
    correction: probabilities.get("correction") ?? 0,
    matches,
  };
}
