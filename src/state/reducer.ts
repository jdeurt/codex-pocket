import { type RpcEvent, type Snapshot, type Turn, object, pretty, string } from "../lib/protocol";
import { findById, upsertById, withoutId } from "../lib/identity";
import { updatedActivity } from "./native-activity";

/** Replace one canonical turn without changing the previous snapshot.
@param state - Previous parent projection.
@param turn - Updated turn.
@returns Snapshot containing the updated turn in its original position.
*/
function withTurn(state: Snapshot, turn: Turn): Snapshot {
  return { ...state, turns: upsertById(state.turns, turn) };
}

/** Apply native model and reasoning settings without discarding absent values.
@param state - Current parent projection.
@param settings - Normalized native settings.
@returns Updated parent projection.
*/
function updatedSettings(state: Snapshot, settings: Record<string, unknown>): Snapshot {
  return {
    ...state,
    model: string(settings.model) || state.model,
    reasoningEffort:
      typeof settings.effort === "string" || settings.effort === null ? settings.effort : state.reasoningEffort,
  };
}

/** Start a native turn while retaining previously hydrated items.
@param state - Current projection.
@param incoming - Started native turn, if supplied.
@param current - Canonical turn already present under this identity.
@returns Updated projection or unchanged state for malformed events.
*/
function startedTurn(state: Snapshot, incoming: Turn | undefined, current: Turn | undefined): Snapshot {
  if (!incoming) {
    return state;
  }

  const turn = { ...(current ?? incoming), status: "inProgress" };

  return {
    ...withTurn(state, turn),
    activeTurnId: turn.id,
    activity: "",
    error: undefined,
    connectionRetry: undefined,
  };
}

/** Clear activity only for the exact completed native turn.
@param state - Current projection.
@param incoming - Completed native turn, if supplied.
@param current - Existing canonical turn.
@returns Updated completion metadata without changing existing items.
*/
function completedTurn(state: Snapshot, incoming: Turn | undefined, current: Turn | undefined): Snapshot {
  if (!incoming) {
    return state;
  }

  const next = current ? withTurn(state, { ...current, status: incoming.status, error: incoming.error }) : state;
  const isActive = state.activeTurnId === incoming.id;

  return {
    ...next,
    activeTurnId: isActive ? undefined : state.activeTurnId,
    activity: isActive ? undefined : state.activity,
    error: incoming.error?.message ?? state.error,
  };
}

/** Merge item lifecycle or text deltas without mutating native event objects.
@param state - Current projection.
@param event - Item lifecycle or delta event.
@param turnId - Native turn identity.
@param current - Existing canonical turn.
@returns Updated transcript projection.
*/
function updatedItem(state: Snapshot, event: RpcEvent, turnId: string, current: Turn | undefined): Snapshot {
  if (event.method === "item/agentMessage/delta") {
    const item = current && findById(current.items, event.params.itemId);

    return current && item
      ? withTurn(state, {
          ...current,
          items: upsertById(current.items, { ...item, text: string(item.text) + string(event.params.delta) }),
        })
      : state;
  }

  const turn = current ?? { id: turnId, status: "inProgress", items: [] };
  const item = event.params.item;

  return withTurn(
    state,
    item
      ? {
          ...turn,
          items: upsertById(turn.items, { ...findById(turn.items, item.id), ...item }),
        }
      : turn
  );
}

/** Separate retrying native connection errors from persistent turn failures.
@param state - Current projection.
@param event - Native error notification.
@param turnId - Associated native turn identity.
@returns Explicit retry or terminal error state.
*/
function recordedError(state: Snapshot, event: RpcEvent, turnId: string): Snapshot {
  const params = event.params;
  const message = string(object(params.error).message) || string(params.message) || pretty(params);

  return turnId && params.willRetry === true
    ? { ...state, connectionRetry: { turnId, message } }
    : { ...state, error: message, connectionRetry: undefined };
}

/** Apply a native event using immutable state transformations.
@param state - Scoped parent projection.
@param event - Validated native event.
@param turnId - Associated turn identity.
@returns Next canonical snapshot.
*/
function scopedEvent(state: Snapshot, event: RpcEvent, turnId: string): Snapshot {
  const params = event.params;
  const turn = findById(state.turns, turnId);

  switch (event.method) {
    case "turn/started": {
      return startedTurn(state, params.turn, turn);
    }

    case "turn/completed": {
      return completedTurn(state, params.turn, turn);
    }

    case "item/started":
    case "item/completed":
    case "item/agentMessage/delta": {
      return updatedItem(state, event, turnId, turn);
    }

    case "serverRequest/resolved": {
      return { ...state, requests: withoutId(state.requests, params.requestId) };
    }

    case "thread/name/updated": {
      return { ...state, title: string(params.threadName) || string(params.name) || "Codex" };
    }

    case "thread/settings/updated": {
      return updatedSettings(state, object(params.threadSettings));
    }

    case "model/rerouted": {
      return { ...state, model: string(params.toModel) || state.model };
    }

    case "error": {
      return recordedError(state, event, turnId);
    }

    default: {
      return state;
    }
  }
}

/** Reject foreign events and return the next state without hidden caches or input mutation.
@param state - Current parent snapshot, left unchanged.
@param event - Validated native notification, left unchanged.
@returns Next snapshot including explicit activity bookkeeping.
*/
export function reduceEvent(state: Snapshot, event: RpcEvent): Snapshot {
  if (event.params.threadId && event.params.threadId !== state.threadId) {
    return state;
  }

  const turnId = string(event.params.turnId) || string(object(event.params.turn).id);
  const isResumed =
    event.method === "item/agentMessage/delta" ||
    event.method === "turn/completed" ||
    (event.method === "item/completed" && event.params.item?.type === "agentMessage");
  const previous =
    isResumed && state.connectionRetry?.turnId === turnId ? { ...state, connectionRetry: undefined } : state;
  const next = scopedEvent(previous, event, turnId);

  return updatedActivity(next, event, findById(next.turns, turnId));
}
