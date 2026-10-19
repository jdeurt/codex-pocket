"use client";
import { type AgentCatalog, type AgentEntry, activeAgent } from "@/lib/agents";
import { useEffect, useRef, useState } from "react";
import { AgentChat } from "./agent-chat";
import { AgentList } from "./agent-list";
import { Dialog } from "@base-ui/react/dialog";
import { useAgentRead } from "@/hooks/use-agents";

function useAgentCatalog(open: boolean) {
  const overview = useAgentRead<AgentCatalog>("/api/agents");
  const detail = useAgentRead<AgentCatalog>("/api/agents?view=list", open);
  const data =
    overview.data && (!detail.data || overview.data.updatedAt > detail.data.updatedAt) ? overview.data : detail.data;

  return {
    data,
    error: open ? (detail.error ?? overview.error) : overview.error,
    count: overview.error ? 0 : (data?.agents.filter(activeAgent).length ?? 0),
  };
}

export function AgentBrowser({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const { data, error, count } = useAgentCatalog(open);
  const [selected, setSelected] = useState<AgentEntry | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [visit, setVisit] = useState<{ data?: AgentCatalog; entries: Map<string, AgentEntry> }>({ entries: new Map() });
  const lastSelected = useRef<string | null>(null);
  // Finished agents stay available throughout this visit, even if discovery stops
  // returning an archived session. Closing clears this visit's retained entries.
  const entries = new Map(
    open
      ? visit.entries
          .entries()
          .map(([id, agent]) => [id, activeAgent(agent) ? { ...agent, status: "unknown" as const } : agent])
      : []
  );

  for (const agent of data?.agents ?? []) {
    entries.set(agent.id, agent);
  }

  if (data !== visit.data) {
    setVisit({ data, entries });
  }

  function back() {
    lastSelected.current = selected?.id ?? null;
    setSelected(null);
  }

  useEffect(() => {
    if (!selected && open && lastSelected.current) {
      rows.current.get(lastSelected.current)?.focus();
    }
  }, [open, selected]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && selected && details.reason === "escape-key") {
          details.cancel();
          back();

          return;
        }

        setOpen(next);
        onOpenChange(next);

        if (next) {
          return;
        }

        setSelected(null);
        setVisit({ data, entries: new Map() });
      }}
    >
      {count > 0 && (
        <Dialog.Trigger className="agents-trigger">
          {count} {count === 1 ? "agent" : "agents"}
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Backdrop className="agents-backdrop" />
        <Dialog.Popup
          className="agents-panel"
          finalFocus={() =>
            document.querySelector<HTMLElement>(".agents-trigger") ??
            document.querySelector<HTMLTextAreaElement>("#message")
          }
        >
          <Dialog.Title className="sr-only">Agents</Dialog.Title>
          <Dialog.Description className="sr-only">
            Agents working in this parent chat. Open an agent to read its conversation.
          </Dialog.Description>
          <AgentList
            entries={entries
              .values()
              .toArray()
              .sort((a, b) => Number(activeAgent(b)) - Number(activeAgent(a)) || a.name.localeCompare(b.name))}
            hidden={!!selected}
            error={error}
            warnings={data?.warnings ?? []}
            rows={rows}
            select={setSelected}
          />
          {selected && <AgentChat key={selected.id} agent={entries.get(selected.id) ?? selected} back={back} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
