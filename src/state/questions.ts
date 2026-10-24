import { type Question } from "../lib/questions";

export type QuestionValues = Partial<Record<string, string>>;

/** Replace one local answer without capturing stale form state.
@param values - Previous answers.
@param change - Explicit question identity and text.
@returns New local answer values.
*/
export function changedAnswer(values: QuestionValues, change: { id: string; value: string }): QuestionValues {
  return { ...values, [change.id]: change.value };
}

/** Build the native answer payload from the displayed questions.
@param questions - Questions owned by this request.
@param values - Current local answer values.
@returns Native request response.
*/
export function questionAnswers(questions: readonly Question[], values: QuestionValues) {
  const answers: Record<string, { answers: (string | undefined)[] }> = {};

  for (const question of questions) {
    answers[question.id] = { answers: [values[question.id]] };
  }

  return { answers };
}

/** Check whether every displayed question has a nonblank answer.
@param questions - Questions owned by this request.
@param values - Current local answer values.
@returns Whether submission is complete.
*/
export function hasAllAnswers(questions: readonly Question[], values: QuestionValues) {
  for (const question of questions) {
    if (!values[question.id]?.trim()) {
      return false;
    }
  }

  return true;
}
