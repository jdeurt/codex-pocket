import { type PendingRequest, object } from "../lib/protocol";
import { MAX_MESSAGE_LENGTH } from "../lib/constants";
import { z } from "zod";

const approval = z.object({ decision: z.enum(["accept", "decline", "cancel"]) }).strict();
const questionAnswerSchema = z.object({ answers: z.array(z.string().max(MAX_MESSAGE_LENGTH)).min(1) });
const answers = z.object({ answers: z.record(z.string(), questionAnswerSchema) }).strict();

/**
Validate a phone answer against the exact pending native question or approval.
@param request - Normalized request determining question IDs or available decisions.
@param input - Untrusted answer body received from the phone.
@returns Native response restricted to the requested decision or turn-scoped permissions.
*/
export function validateAnswer(request: PendingRequest, input: unknown): unknown {
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
    const result = approval.parse(input);
    const available = request.params.availableDecisions;

    if (Array.isArray(available) && !available.includes(result.decision)) {
      throw new Error("That decision is unavailable.");
    }

    return result;
  }

  if (request.method === "item/tool/requestUserInput") {
    const result = answers.parse(input);
    const questions = z.array(z.object({ id: z.string() })).parse(request.params.questions);

    if (
      questions.some((q) => !Object.hasOwn(result.answers, q.id)) ||
      Object.keys(result.answers).some((id) => questions.every((q) => q.id !== id))
    ) {
      throw new Error("Answer each question.");
    }

    return result;
  }

  if (request.method === "item/permissions/requestApproval") {
    const { allow } = z.object({ allow: z.boolean() }).strict().parse(input);

    // Only the exact requested permissions, and only for this turn.
    return { permissions: allow ? object(request.params.permissions) : {}, scope: "turn" };
  }

  throw new Error("Handle this request on the computer with npm run desktop.");
}
