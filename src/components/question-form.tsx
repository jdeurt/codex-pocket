"use client";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Question } from "@/lib/questions";

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
          onValueChange={(selected) => change(selected[0] ?? "")}
          disabled={disabled}
        >
          {question.options.map((option) => (
            <ToggleGroupItem key={option.label} value={option.label} className="prompt-option">
              <span>{option.label}</span>
              {option.description && <span className="option-description">{option.description}</span>}
            </ToggleGroupItem>
          ))}
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
          onChange={(event) => change(event.target.value)}
        />
      </Field>
    </FieldSet>
  );
}

export function QuestionForm({
  questions,
  sending,
  submit,
}: {
  questions: Question[];
  sending: boolean;
  submit: (result: unknown) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit({
          answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [values[question.id]] }])),
        });
      }}
    >
      <FieldGroup>
        {questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            value={values[question.id] ?? ""}
            change={(value) => setValues({ ...values, [question.id]: value })}
            disabled={sending}
          />
        ))}
        <Button type="submit" disabled={sending || questions.some((question) => !values[question.id]?.trim())}>
          {sending ? "Sending…" : "Send answer"}
        </Button>
      </FieldGroup>
    </form>
  );
}
