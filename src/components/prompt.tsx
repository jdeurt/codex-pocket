"use client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { type PendingRequest, object, pretty, string } from "@/lib/protocol";
import { Button } from "@/components/ui/button";
import { QuestionForm } from "./question-form";
import { questionsSchema } from "@/lib/questions";
import { useState } from "react";

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

function Approval({
  request,
  sending,
  submit,
}: {
  request: PendingRequest;
  sending: boolean;
  submit: (result: unknown) => Promise<void>;
}) {
  const permission = request.method === "item/permissions/requestApproval";
  const decisions = request.params.availableDecisions;
  const canAccept = !Array.isArray(decisions) || decisions.includes("accept");
  const canDecline = !Array.isArray(decisions) || decisions.includes("decline");

  return (
    <>
      <p>{string(request.params.reason) || "Codex needs your permission to continue."}</p>
      <ApprovalDetails request={request} />
      <div className="flex flex-wrap gap-2">
        {canDecline && (
          <Button
            disabled={sending}
            onClick={() => void submit(permission ? { allow: false } : { decision: "decline" })}
            variant="outline"
          >
            Decline
          </Button>
        )}
        {canAccept && (
          <Button disabled={sending} onClick={() => void submit(permission ? { allow: true } : { decision: "accept" })}>
            Approve once
          </Button>
        )}
      </div>
    </>
  );
}

export function Prompt({
  request,
  answer,
}: {
  request: PendingRequest;
  answer: (id: string | number, result: unknown) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function submit(result: unknown) {
    setSending(true);
    setError("");

    try {
      await answer(request.id, result);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : "Couldn't send your answer.");
    } finally {
      setSending(false);
    }
  }

  const questions = questionsSchema.safeParse(request.params.questions);
  let title = "Input needed on your computer";
  let content = <p>Handle this request in the terminal on your computer.</p>;

  if (request.method === "item/tool/requestUserInput" && questions.success) {
    title = "A question for you";
    content = <QuestionForm questions={questions.data} sending={sending} submit={submit} />;
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
