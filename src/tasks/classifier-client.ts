import { z } from "zod";
import { TASK_CLASSIFIERS, type ClassifierQuestion } from "./classifier-definitions";
import type { CostScope } from "../lib/costs";
import { pendingCost, decisionCost } from "../state/cost-observations";
import { observeCost } from "../server/cost-store";
import { t } from "try";

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
@param scope - Trusted feature and parent attribution for this actual attempt.
@returns Exactly one validated probability per requested predicate.
*/
export async function classifyPredicates(
  apiKey: string,
  signal: AbortSignal | undefined,
  input: unknown,
  questions: readonly ClassifierQuestion[],
  scope: CostScope
) {
  const attempt = pendingCost(scope, `decision:${crypto.randomUUID()}`, new Date().toISOString());

  observeCost(attempt);
  const timeout = AbortSignal.timeout(TASK_CLASSIFIERS.timeoutMs);
  const fetched = await t(fetch, TASK_CLASSIFIERS.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({ model: TASK_CLASSIFIERS.model, input: JSON.stringify(input), questions }),
  });

  if (!fetched.ok) {
    observeCost(decisionCost(attempt, {}, signal?.aborted ? "aborted" : "failed"));
    throw fetched.error;
  }

  const response = fetched.value;
  const decoded = await t(response.json.bind(response));

  observeCost(decisionCost(attempt, decoded.ok ? decoded.value : {}, response.ok ? "complete" : "failed"));

  if (!response.ok) {
    throw new Error(`Task classification failed (HTTP ${String(response.status)}); preserve unresolved work.`);
  }

  if (!decoded.ok) {
    throw decoded.error;
  }

  const answers = responseSchema.parse(decoded.value).answers;
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
