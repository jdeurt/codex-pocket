"use client";
import { retainButton } from "../runtime/form-events";
import { type AgentEntry, agentSource, agentStatus } from "@/lib/agents";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog } from "@base-ui/react/dialog";
import { type RefObject } from "react";
import { Skeleton } from "./ui/skeleton";

const previewLabels: Record<Exclude<NonNullable<AgentEntry["previewState"]>, "loading">, string> = {
  unavailable: "Preview unavailable.",
  empty: "No visible messages saved yet.",
};

/** Render one agent with explicit navigation and focus bindings.
@param rows - Runtime focus-handle registry.
@param select - Owning navigation action.
@param agent - Validated agent row.
@returns One keyed selectable agent row.
*/
function agentRow(
  rows: RefObject<Map<string, HTMLButtonElement>>,
  select: (agent: AgentEntry) => void,
  agent: AgentEntry
) {
  return (
    <button
      type="button"
      key={agent.id}
      className="agent-row"
      ref={retainButton.bind(undefined, rows, agent.id)}
      onClick={select.bind(undefined, agent)}
    >
      <div className="agent-row-content">
        <span className="agent-row-title">
          <span className="agent-name" title={agent.name}>
            {agent.name}
          </span>
          <span className="agent-status">{agentStatus(agent.status)}</span>
        </span>
        <span className="agent-source">{agentSource(agent)}</span>
        {agent.previewState === "loading" && !agent.preview ? (
          <div className="agent-preview" role="status" aria-label="Loading preview" aria-busy="true">
            <Skeleton className="h-3 w-3/4" />
          </div>
        ) : (
          <span className="agent-preview">
            {agent.preview || previewLabels[agent.previewState === "unavailable" ? "unavailable" : "empty"]}
          </span>
        )}
      </div>
      <ChevronRightIcon aria-hidden="true" />
    </button>
  );
}

/**
Render scoped agent rows with retained focus handles and discovery warnings.
@param props - Normalized entries, visibility, warnings, row refs and selection callback.
@returns The existing agent list and its navigation controls.
*/
export function AgentList({
  entries,
  hidden,
  isLoading,
  error,
  warnings,
  rows,
  select,
}: {
  entries: AgentEntry[];
  hidden: boolean;
  isLoading: boolean;
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
        {Array.from(entries, agentRow.bind(undefined, rows, select))}
        {isLoading && (
          <div role="status" aria-label="Loading agents" className="flex flex-col gap-4 py-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {!isLoading && entries.length === 0 && <p className="agent-notice">No agents are available in this chat.</p>}
      </div>
    </div>
  );
}
