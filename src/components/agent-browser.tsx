"use client";
import { type AgentCatalog, type AgentEntry, agentCatalogSchema, isActiveAgent } from "@/lib/agents";
import { type RefObject, useContext, useEffect, useRef, useState } from "react";
import { ActivityIndicatorContext } from "@/lib/activity-indicator-context";
import { ActivityRow } from "./activity-row";
import { AgentChat } from "./agent-chat";
import { AgentList } from "./agent-list";
import { Dialog } from "@base-ui/react/dialog";
import { useAgentRead } from "@/hooks/use-agents";

/**
Restore focus to the parent activity trigger, falling back to its composer when absent.
@returns The existing parent control, or null when neither control is mounted.
*/
function agentTriggerFocus() {
  return (
    document.querySelector<HTMLElement>(".agents-trigger") ?? document.querySelector<HTMLTextAreaElement>("#message")
  );
}

/**
Keep overview polling active and request full catalog details only while the browser is open.
@param isOpen - Whether the list needs the complete scoped catalog.
@returns The newest catalog, its current read error and the active-agent count.
*/
function useAgentCatalog(isOpen: boolean) {
  const overview = useAgentRead("/api/agents", agentCatalogSchema);
  const detail = useAgentRead("/api/agents?view=list", agentCatalogSchema, isOpen);
  const data =
    overview.data && (!detail.data || overview.data.updatedAt > detail.data.updatedAt) ? overview.data : detail.data;

  return {
    data,
    error: isOpen ? (detail.error ?? overview.error) : overview.error,
    count: overview.error ? 0 : (data?.agents.filter(isActiveAgent).length ?? 0),
  };
}

/**
Browse scoped read-only agents while retaining row focus and parent navigation.
@param props - Parent callback notified when the agent panel opens or closes.
@returns The existing activity trigger and agent dialog.
*/
export function AgentBrowser({
  open,
  selectedId,
  onSelect,
  returnFocusRef,
  onOpenChange,
}: {
  open: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const indicator = useContext(ActivityIndicatorContext);
  const { data, error, count } = useAgentCatalog(open);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [visit, setVisit] = useState<{ data?: AgentCatalog; entries: Map<string, AgentEntry> }>({ entries: new Map() });
  const lastSelected = useRef<string | null>(null);
  // Finished agents stay available throughout this visit, even if discovery stops
  // returning an archived session. Closing clears this visit's retained entries.
  const entries = new Map(
    open
      ? visit.entries
          .entries()
          .map(([id, agent]) => [id, isActiveAgent(agent) ? { ...agent, status: "unknown" as const } : agent])
      : []
  );
  const agents = data?.agents ?? [];

  for (const agent of agents) {
    entries.set(agent.id, agent);
  }

  if (data !== visit.data) {
    setVisit({ data, entries });
  }

  function back() {
    if (returnFocusRef.current) {
      onOpenChange(false);
      onSelect(null);

      return;
    }

    lastSelected.current = selectedId;
    onSelect(null);
  }

  useEffect(() => {
    if (!selectedId && open && lastSelected.current) {
      rows.current.get(lastSelected.current)?.focus();
    }
  }, [open, selectedId]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && selectedId && details.reason === "escape-key") {
          details.cancel();
          back();

          return;
        }

        onOpenChange(next);

        if (next) {
          return;
        }

        onSelect(null);
        setVisit({ data, entries: new Map() });
      }}
    >
      {(count > 0 || indicator) && (
        <ActivityRow>
          {indicator}
          {count > 0 && (
            <Dialog.Trigger className="agents-trigger">
              {count} {count === 1 ? "agent" : "agents"}
            </Dialog.Trigger>
          )}
        </ActivityRow>
      )}
      <Dialog.Portal>
        <Dialog.Backdrop className="agents-backdrop" />
        <Dialog.Popup
          className="agents-panel"
          finalFocus={() => {
            const target = returnFocusRef.current;

            returnFocusRef.current = null;

            return target?.isConnected ? target : agentTriggerFocus();
          }}
        >
          <Dialog.Title className="sr-only">Agents</Dialog.Title>
          <Dialog.Description className="sr-only">
            Agents working in this parent chat. Open an agent to read its conversation.
          </Dialog.Description>
          <AgentList
            entries={entries
              .values()
              .toArray()
              .toSorted((a, b) => Number(isActiveAgent(b)) - Number(isActiveAgent(a)) || a.name.localeCompare(b.name))}
            hidden={!!selectedId}
            error={error}
            warnings={data?.warnings ?? []}
            rows={rows}
            select={(agent) => {
              onSelect(agent.id);
            }}
          />
          {selectedId && <AgentChat key={selectedId} id={selectedId} agent={entries.get(selectedId)} back={back} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
