import { isTaskAuthoritative, type Assignment, type Ledger, type TaskEvent } from "./model";

const BEFORE = -1;

export const ROUTING_VERSION = "provenance-v2";

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
  if (first === second) {
    return 0;
  }

  return first < second ? BEFORE : 1;
}

/** Select authoritative memberships already established for an exact event.
@param state - Parent checkpoint.
@param eventId - Exact source event.
@returns Stable task identity set.
*/
function explicitTasks(state: Ledger, eventId: string) {
  const ids = new Set<string>();
  const authoritative = state.tasks.filter(isTaskAuthoritative.bind(undefined, state.mode));
  const taskIds = new Set<string>();

  for (const task of authoritative) {
    taskIds.add(task.id);
  }

  for (const member of state.memberships) {
    if (member.eventId === eventId && taskIds.has(member.taskId)) {
      ids.add(member.taskId);
    }
  }

  return [...ids].toSorted(compareIds);
}

/** Recognize a request explicitly classified as conversational context.
@param state - Parent checkpoint.
@param eventId - Recorded request identity.
@returns Whether the latest decision establishes conversation without work.
*/
function isConversationalOrigin(state: Ledger, eventId: string) {
  let isConversation = false;

  for (const decision of state.decisions) {
    if (decision.eventId === eventId) {
      isConversation = decision.assignment.kind === "conversation";
    }
  }

  return isConversation;
}

/** Require all recorded work origins of a model invocation to establish the same task set.
@param state - Parent checkpoint.
@param origins - Application-owned request identities consumed by one run.
@returns Shared task membership, or none when origins are missing or disagree.
*/
function commonOriginTasks(state: Ledger, origins: readonly string[]) {
  const taskIds = new Set<string>();
  const tasks = state.tasks.filter(isTaskAuthoritative.bind(undefined, state.mode));

  for (const task of tasks) {
    taskIds.add(task.id);
  }

  let common: string[] | undefined;

  for (const origin of origins) {
    if (isConversationalOrigin(state, origin)) {
      continue;
    }

    const members = new Set<string>();

    for (const member of state.memberships) {
      if (member.eventId === origin && taskIds.has(member.taskId)) {
        members.add(member.taskId);
      }
    }

    const current = [...members].toSorted(compareIds);

    if (current.length === 0 || (common && JSON.stringify(common) !== JSON.stringify(current))) {
      return [];
    }

    common = current;
  }

  return common ?? [];
}

/** Require native assistant outputs to retain an application-owned run origin.
@param event - Recorded source metadata.
@returns Whether an output has usable provenance or is another event kind.
*/
function hasRecordedOutputOrigin(event: TaskEvent) {
  return event.origin !== "assistant" || event.nativeEntryId === undefined || event.turnId !== undefined;
}

/** Collect trusted causal references for work or conversational routing.
@param state - Parent checkpoint.
@param event - Recorded event.
@returns Application-owned event, call and receipt references.
*/
function recordedReferences(state: Ledger, event: TaskEvent) {
  const command = state.commands.find(hasCommandId.bind(undefined, event.commandId));
  const origins = event.requestIds?.length ? event.requestIds : (command?.requestIds ?? []);
  const references = [event.causedBy, event.inReplyTo, event.requestId, command?.requestId, ...origins];

  for (const binding of state.bindings) {
    if (binding.nativeEntryId === event.nativeEntryId) {
      references.push(`request:${binding.receiptId}`);
    }
  }

  return references;
}

/** Propagate an established conversational decision instead of inventing unresolved work for native aliases.
@param state - Parent checkpoint.
@param event - Native record whose known relationships establish no work.
@returns Whether every recorded causal origin is explicitly conversational.
*/
function hasConversationalOrigins(state: Ledger, event: TaskEvent) {
  if (!hasRecordedOutputOrigin(event)) {
    return false;
  }

  const references = recordedReferences(state, event);

  let hasOrigin = false;

  for (const reference of references) {
    if (!reference || reference === event.id) {
      continue;
    }

    const parents = state.events.filter(hasReference.bind(undefined, reference));

    if (parents.length !== 1 || !isConversationalOrigin(state, parents[0].id)) {
      return false;
    }

    hasOrigin = true;
  }

  return hasOrigin;
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

  const ids = new Set(explicitTasks(state, event.id));

  if (ids.size > 0) {
    return [...ids].toSorted(compareIds);
  }

  if (!hasRecordedOutputOrigin(event)) {
    return [];
  }

  const command = state.commands.find(hasCommandId.bind(undefined, event.commandId));
  const origins = event.requestIds?.length ? event.requestIds : (command?.requestIds ?? []);

  if (origins.length > 1) {
    return commonOriginTasks(state, origins);
  }

  const references = recordedReferences(state, event);

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

/** Resolve a delegate assignment's task identities through its recorded originating requests.
@param state - Authoritative parent checkpoint.
@param command - Exact per-command relationship.
@returns Established task identities; missing or conflicting work origins remain unknown.
*/
export function commandTaskIds(state: Ledger, command: Ledger["commands"][number]) {
  const origins = command.requestIds.length > 0 ? command.requestIds : [];
  const references = command.requestId ? [...origins, command.requestId] : origins;
  const unique = [...new Set(references)];

  if (unique.length > 1) {
    return commonOriginTasks(state, unique);
  }

  for (const event of state.events) {
    if (event.id === unique[0]) {
      return relatedTasks(state, event);
    }
  }

  return [];
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

  if (event.nativeRole === "system" || ["recovery", "voice_history"].includes(event.origin)) {
    return { kind: "conversation" };
  }

  const memberships = state.memberships.filter(isOtherEvent.bind(undefined, event.id));
  const taskIds = relatedTasks({ ...state, memberships }, event);

  if (taskIds.length > 0) {
    return { kind: "attach", taskIds };
  }

  if (hasConversationalOrigins(state, event)) {
    return { kind: "conversation" };
  }

  return ["typed", "voice_request", "scheduled"].includes(event.origin)
    ? null
    : { kind: "unresolved", diagnostic: "Missing authoritative request, command, turn or call correlation." };
}
