"use client";
import { type AgentEntry, type AgentTranscript, agentSource, agentStatus } from "@/lib/agents";
import { ArrowLeftIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "./ui/button";
import { Conversation } from "./conversation";
import { Dialog } from "@base-ui/react/dialog";
import { useAgentRead } from "@/hooks/use-agents";

export function AgentChat({ agent, back }: { agent: AgentEntry; back: () => void }) {
  const { data, error } = useAgentRead<AgentTranscript>(`/api/agents?agent=${encodeURIComponent(agent.id)}`);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [agent.id]);
  const current = data?.agent ?? agent;
  const metadata = [current.model, current.reasoningEffort ? `${current.reasoningEffort} reasoning` : undefined]
    .filter(Boolean)
    .join(" · ");

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
        <Dialog.Close render={<Button variant="ghost" size="icon-xl" aria-label="Close agents" />}>
          <XIcon />
        </Dialog.Close>
      </header>
      <p className="agent-read-only">
        {agentSource(current)} · {agentStatus(current.status)} · Read only
      </p>
      {current.status === "failed" && (
        <p className="agent-notice" role="alert">
          This agent’s last turn failed. Its saved messages are shown below.
        </p>
      )}
      {(error || data?.warning) && (
        <p className="agent-notice" role="status">
          {error || data?.warning}
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
