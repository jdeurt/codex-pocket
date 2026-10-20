"use client";
import { type AgentEntry, agentTranscriptSchema } from "@/lib/agents";
import { useEffect, useRef } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Conversation } from "./conversation";
import { useAgentRead } from "@/hooks/use-agents";

/**
Read a selected agent transcript without enabling mutation or model execution.
@param props - Selected normalized agent and the callback that returns to the list.
@returns The centered agent header and read-only conversation.
*/
export function AgentChat({ agent, back }: { agent: AgentEntry; back: () => void }) {
  const { data, error } = useAgentRead(`/api/agents?agent=${encodeURIComponent(agent.id)}`, agentTranscriptSchema);
  const heading = useRef<HTMLHeadingElement>(null);

  const current = data?.agent ?? agent;
  const metadata = [current.model, current.reasoningEffort ? `${current.reasoningEffort} reasoning` : undefined]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    heading.current?.focus();
  }, [agent.id]);

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
          <p className="agent-chat-name" title={current.name}>
            {current.name}
          </p>
          {metadata && <p aria-label="Model and reasoning effort">{metadata}</p>}
        </div>
        <span className="size-11 shrink-0" aria-hidden="true" />
      </header>
      {current.status === "failed" && (
        <p className="agent-notice" role="alert">
          This agent’s last turn failed. Its saved messages are shown below.
        </p>
      )}
      {(error?.length ? error : data?.warning) && (
        <p className="agent-notice" role="status">
          {error?.length ? error : data?.warning}
          {data && " Showing saved history; updates may be stale."}
        </p>
      )}
      {data ? (
        <Conversation
          state={data.state}
          readOnly
          emptyMessage={
            data.history === "unavailable" ? "Saved history is unavailable." : "No visible messages saved yet."
          }
        />
      ) : (
        <p className="agent-notice" role="status">
          {error ? "History has not loaded yet." : "Loading conversation…"}
        </p>
      )}
    </div>
  );
}
