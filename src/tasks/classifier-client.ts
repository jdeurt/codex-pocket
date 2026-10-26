import { z } from "zod";
import { TASK_CLASSIFIERS, type ClassifierQuestion } from "./classifier-definitions";

const answerSchema = z.object({
  type: z.literal("predicate"),
  name: z.string(),
  probability: z.number().min(0).max(1),
});
const responseSchema = z.object({ answers: z.array(answerSchema) });

/** Call the shared predicate transport, rejecting incomplete, duplicate or unrequested answers.
@param apiKey - Server-only provider credential.
@param signal - Cancellation when new input arrives or runtime ownership ends.
@param input - Explicit bounded classifier evidence.
@param questions - Auditable definitions with stable evidence identities.
@returns Exactly one validated probability per requested predicate.
*/
export async function classifyPredicates(
  apiKey: string,
  signal: AbortSignal | undefined,
  input: unknown,
  questions: readonly ClassifierQuestion[]
) {
  const timeout = AbortSignal.timeout(TASK_CLASSIFIERS.timeoutMs);
  const response = await fetch(TASK_CLASSIFIERS.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({ model: TASK_CLASSIFIERS.model, input: JSON.stringify(input), questions }),
  });

  if (!response.ok) {
    throw new Error(`Task classification failed (HTTP ${String(response.status)}); preserve unresolved work.`);
  }

  const answers = responseSchema.parse(await response.json()).answers;
  const probabilities = new Map<string, number>();
  const requested = new Set<string>();

  for (const question of questions) {
    requested.add(question.name);
  }

  for (const answer of answers) {
    if (probabilities.has(answer.name) || !requested.has(answer.name)) {
      throw new Error("Task classifier returned duplicate or unrequested predicates.");
    }

    probabilities.set(answer.name, answer.probability);
  }

  if (probabilities.size !== questions.length) {
    throw new Error("Task classifier returned missing predicates.");
  }

  return probabilities;
}
