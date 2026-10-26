"use client";
import { useNavigationSwipe } from "@/hooks/use-navigation-swipe";
import { useAgentCatalog } from "@/hooks/use-agent-catalog";
import { useBoundCallback } from "@/hooks/use-bound-callback";
import { type AgentVisit, retainedAgents, compareAgents } from "@/state/agent-browser";
import {
  retainAgentTrigger,
  agentFinalFocus,
  backFromAgent,
  focusAgentRow,
  openAgentBrowser,
  selectAgent,
  closeAgentBrowser,
} from "@/runtime/agent-navigation";
import { type RefObject, useContext, useEffect, useRef, useState } from "react";
import { ActivityIndicatorContext } from "@/lib/activity-indicator-context";
import { ActivityRow } from "./activity-row";
import { AgentChat } from "./agent-chat";
import { AgentList } from "./agent-list";
import { Dialog } from "@base-ui/react/dialog";

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
  const trigger = useRef<HTMLButtonElement | null>(null);
  const triggerFocus = useBoundCallback(retainAgentTrigger, trigger);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [visit, setVisit] = useState<AgentVisit>({ entries: new Map() });
  const lastSelected = useRef<string | null>(null);
  // Finished agents stay available throughout this visit, even if discovery stops
  // returning an archived session. Closing clears this visit's retained entries.
  const entries = retainedAgents(visit.entries, data, open);

  if (data !== visit.data) {
    setVisit({ data, entries });
  }

  const back = useBoundCallback(backFromAgent, returnFocusRef, lastSelected, selectedId, onOpenChange, onSelect);
  const restoreRow = useBoundCallback(focusAgentRow, rows, lastSelected, selectedId, open);
  const close = useBoundCallback(closeAgentBrowser, onOpenChange, onSelect, setVisit, data);
  const swipe = useNavigationSwipe(open, undefined, selectedId ? back : close);
  const finalFocus = useBoundCallback(agentFinalFocus, returnFocusRef);

  useEffect(restoreRow, [restoreRow]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={openAgentBrowser.bind(undefined, back, onOpenChange, onSelect, setVisit, selectedId, data)}
    >
      <ActivityRow>
        {indicator}
        {count > 0 && (
          <Dialog.Trigger className="agents-trigger" ref={triggerFocus}>
            <span className="agents-label">
              {count} {count === 1 ? "agent" : "agents"}
            </span>
          </Dialog.Trigger>
        )}
      </ActivityRow>
      <Dialog.Portal>
        <Dialog.Backdrop className="agents-backdrop" />
        <Dialog.Popup ref={swipe} className="agents-panel" finalFocus={finalFocus}>
          <Dialog.Title className="sr-only">Agents</Dialog.Title>
          <Dialog.Description className="sr-only">
            Agents working in this parent chat. Open an agent to read its conversation.
          </Dialog.Description>
          <AgentList
            entries={entries.values().toArray().toSorted(compareAgents)}
            hidden={!!selectedId}
            isLoading={!data && !error}
            error={error}
            warnings={data?.warnings ?? []}
            rows={rows}
            select={selectAgent.bind(undefined, onSelect)}
          />
          {selectedId && <AgentChat key={selectedId} id={selectedId} agent={entries.get(selectedId)} back={back} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
