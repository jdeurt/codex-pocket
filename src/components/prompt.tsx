"use client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { type PendingRequest, object, pretty, string } from "@/lib/protocol";
import { type Question, questionsSchema } from "@/lib/questions";
import { Button } from "@/components/ui/button";
import { QuestionForm } from "./question-form";
import { usePocketClient } from "@/providers/pocket-state";
import { requestAnswer } from "@/runtime/question-form";
import { useStore } from "zustand";

/**
Display native approval details using the shared code-block presentation.
@param props - Normalized pending native request whose arguments remain display data.
@returns The approval description and exact request details.
*/
function ApprovalDetails({ request }: { request: PendingRequest }) {
  return (
    <>
      {request.params.command ? (
        <CodeBlock size="sm">
          <CodeBlockContent wrap>{string(request.params.command)}</CodeBlockContent>
        </CodeBlock>
      ) : undefined}
      {request.params.cwd ? <p className="break-all">{string(request.params.cwd)}</p> : undefined}
      {request.params.networkApprovalContext ? <p>{pretty(request.params.networkApprovalContext)}</p> : undefined}
      {request.method === "item/permissions/requestApproval" ? (
        <CodeBlock size="sm">
          <CodeBlockContent wrap>{pretty(object(request.params.permissions))}</CodeBlockContent>
        </CodeBlock>
      ) : undefined}
    </>
  );
}

/**
Present the native approval choices and caller-owned response state.
@param props - Pending request, sending state and the callback that sends its answer.
@returns The existing approval controls.
*/
function Approval({
  request,
  sending,
  submit,
}: {
  request: PendingRequest;
  sending: boolean;
  submit: (result: unknown) => Promise<void>;
}) {
  const isPermission = request.method === "item/permissions/requestApproval";
  const decisions = request.params.availableDecisions;
  const canAccept = !Array.isArray(decisions) || decisions.includes("accept");
  const canDecline = !Array.isArray(decisions) || decisions.includes("decline");

  return (
    <>
      <p>{string(request.params.reason) || "Pocket needs your permission to continue."}</p>
      <ApprovalDetails request={request} />
      <div className="flex flex-wrap gap-2">
        {canDecline && (
          <Button
            disabled={sending}
            onClick={requestAnswer.bind(undefined, submit, isPermission ? { allow: false } : { decision: "decline" })}
            variant="outline"
          >
            Decline
          </Button>
        )}
        {canAccept && (
          <Button
            disabled={sending}
            onClick={requestAnswer.bind(undefined, submit, isPermission ? { allow: true } : { decision: "accept" })}
          >
            Approve once
          </Button>
        )}
      </div>
    </>
  );
}

/**
Present editable question, approval or terminal-only content for a normalized pending request.
@param props - Native request, validated questions and caller-owned answer state.
@returns The matching request controls and any failed-answer message.
*/
function PromptForm({
  request,
  questions,
  sending,
  submit,
  error,
}: {
  request: PendingRequest;
  questions: Question[] | undefined;
  sending: boolean;
  submit: (result: unknown) => Promise<void>;
  error: string;
}) {
  let title = "Input needed on your computer";
  let content = <p>Handle this request in the terminal on your computer.</p>;

  if (questions && request.method === "item/tool/requestUserInput") {
    title = "A question for you";
    content = <QuestionForm questions={questions} sending={sending} submit={submit} />;
  } else if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(request.method)
  ) {
    title = "Approval needed";
    content = <Approval request={request} sending={sending} submit={submit} />;
  }

  return (
    <Alert className="prompt">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <div className="flex w-full flex-col gap-4">
          {content}
          {error && <p role="alert">{error}</p>}
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Render the text of a read-only native question.
@param question - Validated question.
@returns Stable question paragraph.
*/
function questionText(question: Question) {
  return <p key={question.id}>{question.question}</p>;
}

/**
Select user-input questions or native approval controls for a pending request.
@param props - Normalized request and the callback that owns sending its answer.
@returns The matching existing request form.
*/
export function Prompt({ request, readOnly = false }: { request: PendingRequest; readOnly?: boolean }) {
  const client = usePocketClient();
  const operation = client.operation(`answer:${String(request.id)}`);
  const { busy: sending, error } = useStore(operation.store);

  const questions = questionsSchema.safeParse(request.params.questions);

  if (readOnly) {
    return (
      <Alert className="prompt">
        <AlertTitle>Waiting for input</AlertTitle>
        <AlertDescription>
          <div className="flex w-full flex-col gap-4">
            {questions.success ? (
              Array.from(questions.data, questionText)
            ) : (
              <p>{string(request.params.reason) || "This agent has a pending request."}</p>
            )}
            <p>Read only. Handle this request from the parent chat or on your computer.</p>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <PromptForm
      request={request}
      questions={questions.success ? questions.data : undefined}
      sending={sending}
      submit={client.answer.bind(undefined, request.id)}
      error={error}
    />
  );
}
