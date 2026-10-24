"use client";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useId, useReducer } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changedAnswer, hasAllAnswers, type QuestionValues } from "@/state/questions";
import { selectAnswer, submitQuestions, updateAnswer } from "@/runtime/question-form";
import { updateInput } from "@/runtime/form-events";
import { type Question } from "@/lib/questions";

/** Render an explicit native question option.
@param option - Option label and explanation.
@returns Stable selectable option.
*/
function questionOption(option: NonNullable<Question["options"]>[number]) {
  return (
    <ToggleGroupItem key={option.label} value={option.label} className="prompt-option">
      <span>{option.label}</span>
      {option.description && <span className="option-description">{option.description}</span>}
    </ToggleGroupItem>
  );
}

/**
Render one question using its declared text, secret or option input behavior.
@param props - Question definition, current value and the callback that owns its update.
@returns The existing labeled native question control.
*/
function QuestionField({
  question,
  value,
  change,
  disabled,
}: {
  question: Question;
  value: string;
  change: (value: string) => void;
  disabled: boolean;
}) {
  const inputId = useId();

  return (
    <FieldSet>
      <FieldLegend>{question.question}</FieldLegend>
      {question.options?.length ? (
        <ToggleGroup
          orientation="vertical"
          className="prompt-options"
          value={value ? [value] : []}
          onValueChange={selectAnswer.bind(undefined, change)}
          disabled={disabled}
        >
          {Array.from(question.options, questionOption)}
        </ToggleGroup>
      ) : undefined}
      <Field>
        <FieldLabel htmlFor={inputId} className="sr-only">
          Your answer
        </FieldLabel>
        <Input
          id={inputId}
          placeholder="Your answer"
          type={question.isSecret ? "password" : "text"}
          autoComplete="off"
          disabled={disabled}
          value={value}
          onChange={updateInput.bind(undefined, change)}
        />
      </Field>
    </FieldSet>
  );
}

/** Bind one field to explicit form values and reducer dispatch.
@param values - Current local answers.
@param isSending - Whether the request is pending.
@param dispatch - Local reducer dispatch.
@param question - Validated question.
@returns Stable controlled field.
*/
function questionField(
  values: QuestionValues,
  isSending: boolean,
  dispatch: (change: { id: string; value: string }) => void,
  question: Question
) {
  return (
    <QuestionField
      key={question.id}
      question={question}
      value={values[question.id] ?? ""}
      change={updateAnswer.bind(undefined, dispatch, question.id)}
      disabled={isSending}
    />
  );
}

/**
Collect and submit answers for the current native question set.
@param props - Normalized questions, sending state and the caller-owned submission callback.
@returns The current question fields and submit control.
*/
export function QuestionForm({
  questions,
  sending,
  submit,
}: {
  questions: Question[];
  sending: boolean;
  submit: (result: unknown) => Promise<void>;
}) {
  const [values, dispatch] = useReducer(changedAnswer, {});

  return (
    <form onSubmit={submitQuestions.bind(undefined, submit, questions, values)}>
      <FieldGroup>
        {Array.from(questions, questionField.bind(undefined, values, sending, dispatch))}
        <Button type="submit" disabled={sending || !hasAllAnswers(questions, values)}>
          {sending ? "Sending…" : "Send answer"}
        </Button>
      </FieldGroup>
    </form>
  );
}
