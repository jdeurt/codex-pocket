import type { Assignment, Ledger, TaskEvent } from "./model";

export const ROUTING_VERSION = "provenance-v1";

/** Match an explicit command identity.
@param id - Requested identity.
@param command - Recorded command.
@returns Identity equality.
*/
function hasCommandId(id: string | undefined, command: Ledger["commands"][number]) {
  return command.id === id;
}

/** Match a recorded request, receipt or event identity.
@param id - Requested identity.
@param event - Recorded event.
@returns Identity equality.
*/
function hasReference(id: string, event: TaskEvent) {
  return event.id === id || (id.startsWith("call:") && (event.callIds ?? []).includes(id.slice("call:".length)));
}

/** Order opaque task identities deterministically.
@param first - First identity.
@param second - Second identity.
@returns Lexical ordering.
*/
function compareIds(first: string, second: string) {
  return first.localeCompare(second);
}

/** Follow recorded causal identities without inspecting transport markers or recent-task order.
@param state - Parent-scoped ledger.
@param event - Source event to route.
@param visited - Explicit cycle guard for malformed correlations.
@returns Known task associations, including multiple-task requests.
*/
export function relatedTasks(state: Ledger, event: TaskEvent, visited: readonly string[] = []): string[] {
  if (visited.includes(event.id)) {
    return [];
  }

  const ids = new Set<string>();

  for (const member of state.memberships) {
    if (member.eventId === event.id) {
      ids.add(member.taskId);
    }
  }

  const command = state.commands.find(hasCommandId.bind(undefined, event.commandId));
  const references = [event.causedBy, event.inReplyTo, command?.requestId, event.requestId];

  for (const reference of references) {
    if (!reference || reference === event.id) {
      continue;
    }

    const parents = state.events.filter(hasReference.bind(undefined, reference));
    const parent = parents.length === 1 ? parents[0] : undefined;

    if (!parent) {
      continue;
    }

    const inherited = relatedTasks(state, parent, [...visited, event.id]);

    for (const id of inherited) {
      ids.add(id);
    }
  }

  return [...ids].toSorted(compareIds);
}

/** Exclude an event's old derived assignment when reconsidering its causal relationships.
@param eventId - Event being reconsidered.
@param member - Existing membership.
@returns Whether this is another event's authoritative association.
*/
function isOtherEvent(eventId: string, member: Ledger["memberships"][number]) {
  return member.eventId !== eventId;
}

/** Route trusted application relationships before requesting semantic interpretation.
@param state - Exact input checkpoint.
@param event - Trusted source metadata, never extracted from prose.
@returns Deterministic assignment, or null when intent interpretation is necessary.
*/
export function routeEvent(state: Ledger, event: TaskEvent): Assignment | null {
  if (event.parentId !== state.parentId) {
    throw new Error("Task event belongs to another parent.");
  }

  if (["recovery", "voice_history"].includes(event.origin)) {
    return { kind: "conversation" };
  }

  const memberships = state.memberships.filter(isOtherEvent.bind(undefined, event.id));
  const taskIds = relatedTasks({ ...state, memberships }, event);

  if (taskIds.length > 0) {
    return { kind: "attach", taskIds };
  }

  return ["typed", "voice_request", "scheduled"].includes(event.origin)
    ? null
    : { kind: "unresolved", diagnostic: "Missing authoritative request, command, turn or call correlation." };
}
