"use client";
import { type AgentEntry, agentSource, agentStatus } from "@/lib/agents";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog } from "@base-ui/react/dialog";
import { type RefObject } from "react";

const previewLabels: Record<NonNullable<AgentEntry["previewState"]>, string> = {
  loading: "Loading preview…",
  unavailable: "Preview unavailable.",
  empty: "No visible messages saved yet.",
};

/**
Render scoped agent rows with retained focus handles and discovery warnings.
@param props - Normalized entries, visibility, warnings, row refs and selection callback.
@returns The existing agent list and its navigation controls.
*/
export function AgentList({
  entries,
  hidden,
  error,
  warnings,
  rows,
  select,
}: {
  entries: AgentEntry[];
  hidden: boolean;
  error?: string;
  warnings: string[];
  rows: RefObject<Map<string, HTMLButtonElement>>;
  select: (agent: AgentEntry) => void;
}) {
  return (
    <div className="agents-list-view" hidden={hidden}>
      <header className="agents-list-header">
        <Dialog.Close render={<Button variant="ghost" size="icon-xl" aria-label="Back to Pocket" />}>
          <ArrowLeftIcon />
        </Dialog.Close>
        <h2>Agents</h2>
        <span className="size-11 shrink-0" aria-hidden="true" />
      </header>
      <div className="agents-list">
        {error || warnings.length > 0 ? (
          <p className="agent-notice" role="status">
            {error?.length ? error : warnings.join(" ")}
            {error && " Showing the last update; statuses may be stale."}
          </p>
        ) : null}
        {entries.map((agent) => (
          <button
            type="button"
            key={agent.id}
            className="agent-row"
            ref={(node) => {
              if (node) {
                rows.current.set(agent.id, node);
              } else {
                rows.current.delete(agent.id);
              }
            }}
            onClick={() => {
              select(agent);
            }}
          >
            <span className="agent-row-content">
              <span className="agent-row-title">
                <span className="agent-name" title={agent.name}>
                  {agent.name}
                </span>
                <span className="agent-status">{agentStatus(agent.status)}</span>
              </span>
              <span className="agent-source">{agentSource(agent)}</span>
              <span className="agent-preview">{agent.preview || previewLabels[agent.previewState ?? "empty"]}</span>
            </span>
            <ChevronRightIcon aria-hidden="true" />
          </button>
        ))}
        {entries.length === 0 && <p className="agent-notice">No agents are available in this chat.</p>}
      </div>
    </div>
  );
}
