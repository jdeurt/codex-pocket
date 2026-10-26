import { TASK_CLASSIFIERS, type ClassifierQuestion } from "./classifier-definitions";
import { classifyPredicates } from "./classifier-client";
import type { LifecycleInput } from "./lifecycle-evidence";

/** Assess lifecycle separately from the working agent, using exact event identities for supporting evidence.
@param apiKey - Current server-only provider credential.
@param signal - Runtime-owned preemption boundary.
@param input - Bounded source evidence and application-owned execution/delivery facts.
@param parentId - Trusted owning Pocket identity for accounting.
@returns Validated assessment probabilities; deterministic policy owns transitions.
*/
export function classifyTaskLifecycle(
  apiKey: string,
  signal: AbortSignal | undefined,
  input: LifecycleInput,
  parentId: string
) {
  const definition = TASK_CLASSIFIERS.lifecycle;
  const questions: ClassifierQuestion[] = [...definition.questions];

  for (const [index, event] of input.events.entries()) {
    questions.push(
      {
        type: "predicate",
        name: `${definition.evidencePrefix}${String(index)}`,
        instructions: `${definition.evidencePredicate} Exact event: ${JSON.stringify(event.eventId)}.`,
      },
      {
        type: "predicate",
        name: `${definition.pendingQuestionPrefix}${String(index)}`,
        instructions: `${definition.pendingQuestionPredicate} Exact event: ${JSON.stringify(event.eventId)}.`,
      }
    );
  }

  for (const [index, question] of input.task.pendingQuestions.entries()) {
    questions.push({
      type: "predicate",
      name: `${definition.answeredQuestionPrefix}${String(index)}`,
      instructions: `${definition.answeredQuestionPredicate} Specific question: ${JSON.stringify(question)}.`,
    });
  }

  return classifyPredicates(apiKey, signal, input, questions, {
    parentId,
    feature: "task_lifecycle",
    provider: "openai",
    model: TASK_CLASSIFIERS.model,
  });
}
