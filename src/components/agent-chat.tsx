"use client";
import { type AgentEntry, type AgentTranscript, agentTranscriptSchema, isActiveAgent } from "@/lib/agents";
import { useEffect, useRef } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Conversation } from "./conversation";
import { initialSnapshot } from "@/lib/protocol";
import { useAgentRead } from "@/hooks/use-agents";

/**
Report history failures while background refreshes remain quiet.
@param props - Retained transcript and recoverable transport failure.
@returns A history error at the conversation tail, or no notice.
*/
function HistoryReadStatus({ data, error }: { data?: AgentTranscript; error?: string }) {
  if (error || data?.history === "unavailable") {
    return (
      <div className="py-3 text-sm text-muted-foreground" role="alert" aria-label="History refresh failed">
        <p>Latest history could not be loaded.</p>
        <p>{error ?? data?.warning}</p>
        {data && <p>Showing saved history; updates may be stale.</p>}
      </div>
    );
  }

  return null;
}

/**
Retain saved conversation content during reads and expose explicit failures.
@param props - Last readable transcript and current transport error.
@returns Saved conversation or the existing error notice.
*/
function AgentHistory({ data, error }: { data?: AgentTranscript; error?: string }) {
  if (!data && error) {
    return (
      <div className="agent-notice">
        <HistoryReadStatus error={error} />
      </div>
    );
  }

  return (
    <Conversation
      state={data?.state ?? { ...initialSnapshot, connection: "connected" }}
      readOnly
      isWorking={!!data && isActiveAgent(data.agent)}
      footer={<HistoryReadStatus data={data} error={error} />}
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
  const { data, error } = useAgentRead(`/api/agents?agent=${encodeURIComponent(id)}`, agentTranscriptSchema);
  const heading = useRef<HTMLHeadingElement>(null);

  const current = data?.agent ?? agent;

  useEffect(() => {
    heading.current?.focus();
  }, [id]);

  return (
    <div className="agent-chat pb-[max(24px,env(safe-area-inset-bottom))]">
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
      <AgentHistory data={data} error={error} />
    </div>
  );
}
