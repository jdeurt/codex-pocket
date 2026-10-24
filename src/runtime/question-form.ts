import { type SubmitEvent } from "react";
import { type Question } from "../lib/questions";
import { questionAnswers, type QuestionValues } from "../state/questions";

/** Dispatch a native answer through the operation that owns errors and pending state.
@param submit - Owning asynchronous answer operation.
@param result - Explicit answer payload.
*/
export function requestAnswer(submit: (result: unknown) => Promise<void>, result: unknown) {
  void submit(result);
}

/** Submit a question form's explicit local values.
@param submit - Owning answer operation.
@param questions - Questions displayed by this form.
@param values - Local answer values.
@param event - Native form submission.
*/
export function submitQuestions(
  submit: (result: unknown) => Promise<void>,
  questions: Question[],
  values: QuestionValues,
  event: SubmitEvent<HTMLFormElement>
) {
  event.preventDefault();
  requestAnswer(submit, questionAnswers(questions, values));
}

/** Publish the native toggle group's selected value.
@param change - Owning local answer setter.
@param selected - Native selection values.
*/
export function selectAnswer(change: (value: string) => void, selected: string[]) {
  change(selected[0] ?? "");
}

/** Dispatch an explicit local question update.
@param dispatch - Local reducer dispatch.
@param id - Question identity.
@param value - New answer text.
*/
export function updateAnswer(dispatch: (change: { id: string; value: string }) => void, id: string, value: string) {
  dispatch({ id, value });
}
