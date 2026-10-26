import { type RefObject } from "react";
import { type AgentCatalog, type AgentEntry } from "../lib/agents";
import { type AgentVisit } from "../state/agent-browser";

/** Restore focus to an active trigger or the parent composer.
@returns Existing native return target, if mounted.
*/
function agentTriggerFocus() {
  return (
    document.querySelector<HTMLElement>(".agents-trigger") ?? document.querySelector<HTMLTextAreaElement>("#message")
  );
}

/** Transfer focus when a completed agent removes the active trigger.
@param current - Native trigger reference.
@param trigger - Mounted button or removal notification.
*/
export function retainAgentTrigger(current: RefObject<HTMLButtonElement | null>, trigger: HTMLButtonElement | null) {
  const previous = current.current;

  current.current = trigger;

  if (!trigger && previous && previous === document.activeElement) {
    document.querySelector<HTMLTextAreaElement>("#message")?.focus({ preventScroll: true });
  }
}

/** Consume a retained native return target when closing the dialog.
@param focus - Parent's retained activation target.
@returns Connected trigger, or the normal parent fallback.
*/
export function agentFinalFocus(focus: RefObject<HTMLElement | null>) {
  const target = focus.current;

  focus.current = null;

  return target?.isConnected ? target : agentTriggerFocus();
}

/** Return from an agent opened through a transcript link or list row.
@param focus - Parent's retained activation target.
@param lastSelected - Last row to restore on returning to the list.
@param selected - Current agent identity.
@param open - Parent modal setter.
@param select - Parent selection setter.
*/
export function backFromAgent(
  focus: RefObject<HTMLElement | null>,
  lastSelected: RefObject<string | null>,
  selected: string | null,
  open: (isOpen: boolean) => void,
  select: (id: string | null) => void
) {
  if (focus.current) {
    open(false);
  } else {
    lastSelected.current = selected;
  }

  select(null);
}

/** Restore the selected row after React commits the list view.
@param rows - Mounted row registry.
@param lastSelected - Last visited row.
@param selected - Current agent identity.
@param isOpen - Whether the modal remains open.
*/
export function focusAgentRow(
  rows: RefObject<Map<string, HTMLButtonElement>>,
  lastSelected: RefObject<string | null>,
  selected: string | null,
  isOpen: boolean
) {
  if (!selected && isOpen && lastSelected.current) {
    rows.current.get(lastSelected.current)?.focus();
  }
}

/** Preserve nested Escape navigation and reset retained entries on dialog close.
@param back - Bound back navigation.
@param open - Parent modal setter.
@param select - Parent selection setter.
@param publishVisit - Local retained catalog setter.
@param selected - Currently selected agent.
@param data - Latest catalog.
@param isOpen - Native requested modal state.
@param details - Native modal reason and cancellation.
*/
export function openAgentBrowser(
  back: () => void,
  open: (isOpen: boolean) => void,
  select: (id: string | null) => void,
  publishVisit: (visit: AgentVisit) => void,
  selected: string | null,
  data: AgentCatalog | undefined,
  isOpen: boolean,
  details: { reason: string; cancel: () => void }
) {
  if (!isOpen && selected && details.reason === "escape-key") {
    details.cancel();
    back();

    return;
  }

  open(isOpen);

  if (isOpen) {
    return;
  }

  select(null);
  publishVisit({ data, entries: new Map() });
}

/** Publish a native list selection to its owning view.
@param select - Parent selection setter.
@param agent - Selected catalog entry.
*/
export function selectAgent(select: (id: string | null) => void, agent: AgentEntry) {
  select(agent.id);
}

/** Return from the agent list while resetting this visit's retained entries.
@param open - Parent modal setter.
@param select - Parent selection setter.
@param publishVisit - Retained catalog setter.
@param data - Latest catalog.
*/
export function closeAgentBrowser(
  open: (isOpen: boolean) => void,
  select: (id: string | null) => void,
  publishVisit: (visit: AgentVisit) => void,
  data: AgentCatalog | undefined
) {
  open(false);
  select(null);
  publishVisit({ data, entries: new Map() });
}
