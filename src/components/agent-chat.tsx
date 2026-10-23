"use client";
import { type AgentEntry, type AgentTranscript, agentTranscriptSchema } from "@/lib/agents";
import { useEffect, useRef } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Conversation } from "./conversation";
import { initialSnapshot } from "@/lib/protocol";
import { Skeleton } from "./ui/skeleton";
import { useAgentRead } from "@/hooks/use-agents";

/**
Describe latest-history reads separately from the agent's execution activity.
@param props - Retained transcript, current request state and recoverable transport failure.
@returns A transient history status at the conversation tail, outside canonical messages.
*/
function HistoryReadStatus({ data, error, isLoading }: { data?: AgentTranscript; error?: string; isLoading: boolean }) {
  if (error || data?.history === "unavailable") {
    return (
      <div className="py-3 text-sm text-muted-foreground" role="alert" aria-label="History refresh failed">
        <p>Latest history could not be loaded.</p>
        <p>{error ?? data?.warning}</p>
        {data && <p>Showing saved history; updates may be stale.</p>}
      </div>
    );
  }

  if (isLoading || data?.isHistoryLoading) {
    return (
      <div
        className="flex flex-col gap-2 py-3 text-sm text-muted-foreground"
        role="status"
        aria-label="Loading latest history"
        aria-busy="true"
      >
        <p>Loading latest history…</p>
        {data && <p>Saved messages may not be current yet.</p>}
        <Skeleton className="h-2 w-1/2" />
      </div>
    );
  }

  return null;
}

/**
Use the shared conversation skeleton until history arrives, retaining explicit read failures.
@param props - Last readable transcript, request loading state and current transport error.
@returns Saved conversation, loading skeleton or the existing error notice.
*/
function AgentHistory({ data, error, isLoading }: { data?: AgentTranscript; error?: string; isLoading: boolean }) {
  if (!data && error) {
    return (
      <div className="agent-notice">
        <HistoryReadStatus error={error} isLoading={false} />
      </div>
    );
  }

  return (
    <Conversation
      state={data?.state ?? initialSnapshot}
      readOnly
      footer={<HistoryReadStatus data={data} error={error} isLoading={isLoading} />}
      emptyMessage={
        data?.history === "unavailable" ? "Saved history is unavailable." : "No visible messages saved yet."
      }
    />
  );
}

/**
Read a selected agent transcript without enabling mutation or model execution.
@param props - Selected normalized agent and the callback that returns to the list.
@returns The centered agent header and read-only conversation.
*/
export function AgentChat({ id, agent, back }: { id: string; agent?: AgentEntry; back: () => void }) {
  const { data, error, isLoading } = useAgentRead(`/api/agents?agent=${encodeURIComponent(id)}`, agentTranscriptSchema);
  const heading = useRef<HTMLHeadingElement>(null);

  const current = data?.agent ?? agent;

  useEffect(() => {
    heading.current?.focus();
  }, [id]);

  return (
    <div className="agent-chat">
      <header className="chat-header agent-chat-header">
        <Button variant="ghost" size="icon-xl" aria-label="Back to agents" onClick={back}>
          <ArrowLeftIcon />
        </Button>
        <div className="thread-heading">
          <h1 ref={heading} tabIndex={-1}>
            Side Pocket
          </h1>
          <p className="agent-chat-name" title={current?.name ?? "Agent"}>
            {current?.name ?? "Agent"}
          </p>
        </div>
        <span className="size-11 shrink-0" aria-hidden="true" />
      </header>
      {current?.status === "failed" && (
        <p className="agent-notice" role="alert">
          This agent’s last turn failed. Its saved messages are shown below.
        </p>
      )}
      <AgentHistory data={data} error={error} isLoading={isLoading} />
    </div>
  );
}
