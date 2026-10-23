import { type Item, type RpcEvent, type Snapshot, type Turn, object, pretty, string } from "../lib/protocol";
import { updateActivity } from "./activity";

const MISSING_INDEX = -1;

/**
Apply native model and reasoning-effort updates without discarding absent settings.
@param state - Mutable current parent snapshot.
@param settings - Normalized native thread settings.
*/
function updateSettings(state: Snapshot, settings: Record<string, unknown>) {
  state.model = string(settings.model) || state.model;

  if (typeof settings.effort === "string" || settings.effort === null) {
    state.reasoningEffort = settings.effort;
  }
}

/**
Start a native turn without replacing an already hydrated canonical turn.
@param state - Mutable parent snapshot receiving native lifecycle state.
@param incoming - Native started turn, absent for a malformed lifecycle event.
@param current - Canonical turn already present under this identity.
@returns The canonical started turn, or the prior value when no native turn was supplied.
*/
function startNativeTurn(state: Snapshot, incoming: Turn | undefined, current: Turn | undefined) {
  let turn = current;

  if (!incoming) {
    return turn;
  }

  if (!turn) {
    turn = { ...incoming, items: incoming.items };
    state.turns.push(turn);
  }

  turn.status = "inProgress";
  state.activeTurnId = turn.id;
  state.activity = "";
  state.error = undefined;
  state.connectionRetry = undefined;

  return turn;
}

/**
Apply completion metadata and clear activity only for the exact active native turn.
@param state - Mutable parent snapshot receiving lifecycle state.
@param incoming - Completed native turn when supplied by the event.
@param current - Existing canonical turn whose status and error may change.
*/
function completeNativeTurn(state: Snapshot, incoming: Turn | undefined, current: Turn | undefined) {
  if (!incoming) {
    return;
  }

  if (current) {
    current.status = incoming.status;
    current.error = incoming.error;
  }

  if (state.activeTurnId === incoming.id) {
    state.activeTurnId = undefined;
    state.activity = undefined;
  }

  if (incoming.error) {
    state.error = incoming.error.message;
  }
}

/**
Merge a native item into its canonical position without duplicating a started item.
@param turn - Canonical turn receiving the item.
@param item - Validated native item from a started or completed notification.
*/
function mergeItem(turn: Turn, item: Item) {
  const index = turn.items.findIndex((entry) => entry.id === item.id);

  if (index === MISSING_INDEX) {
    turn.items.push(item);
  } else {
    turn.items[index] = { ...turn.items[index], ...item };
  }
}

/**
Create an observed native turn when necessary and merge its supplied item in place.
@param state - Canonical parent snapshot that owns the turn list.
@param item - Native item, absent when the event carries no item data.
@param turnId - Native turn identity derived by the shared protocol adapter.
@param current - Existing canonical turn under that identity.
@returns The canonical turn, including the existing empty-turn behavior for missing item data.
*/
function updateNativeItem(state: Snapshot, item: Item | undefined, turnId: string, current: Turn | undefined) {
  const turn = current ?? { id: turnId, status: "inProgress", items: [] };

  if (!current) {
    state.turns.push(turn);
  }

  if (item) {
    mergeItem(turn, item);
  }

  return turn;
}

/**
Clear a transient native retry only after assistant output resumes for its exact turn.
@param state - Owning parent snapshot.
@param event - Native progress or completion event, already scoped to the parent.
@param turnId - Native turn that produced this event.
*/
function clearRecoveredRetry(state: Snapshot, event: RpcEvent, turnId: string) {
  const isResumed =
    event.method === "item/agentMessage/delta" ||
    event.method === "turn/completed" ||
    (event.method === "item/completed" && event.params.item?.type === "agentMessage");

  if (isResumed && state.connectionRetry?.turnId === turnId) {
    state.connectionRetry = undefined;
  }
}

/**
Separate explicitly retrying native connection errors from persistent turn failures.
@param state - Owning parent snapshot.
@param event - Scoped native error with its explicit retry flag.
@param turnId - Turn associated with the native error.
*/
function recordError(state: Snapshot, event: RpcEvent, turnId: string) {
  const params = event.params;
  const message = string(object(params.error).message) || string(params.message) || pretty(params);

  if (turnId && params.willRetry === true) {
    state.connectionRetry = { turnId, message };
  } else {
    state.error = message;
    state.connectionRetry = undefined;
  }
}

/**
Apply an already scoped native event and then update its canonical activity projection.
@param state - Mutable current parent snapshot.
@param event - Validated native notification scoped before mutation.
*/
function reduceScopedEvent(state: Snapshot, event: RpcEvent) {
  const params = event.params;
  const turnId = string(params.turnId) || string(object(params.turn).id);

  clearRecoveredRetry(state, event, turnId);

  let turn = state.turns.find((entry) => entry.id === turnId);

  switch (event.method) {
    case "turn/started": {
      turn = startNativeTurn(state, params.turn, turn);
      break;
    }

    case "turn/completed": {
      completeNativeTurn(state, params.turn, turn);
      break;
    }

    case "item/started":
    case "item/completed": {
      turn = updateNativeItem(state, params.item, turnId, turn);
      break;
    }

    case "item/agentMessage/delta": {
      const item = turn?.items.find((entry) => entry.id === params.itemId);

      if (item) {
        item.text = string(item.text) + string(params.delta);
      }

      break;
    }

    case "serverRequest/resolved": {
      state.requests = state.requests.filter((request) => request.id !== params.requestId);
      break;
    }

    case "thread/name/updated": {
      state.title = string(params.threadName) || string(params.name) || "Codex";
      break;
    }

    case "thread/settings/updated": {
      updateSettings(state, object(params.threadSettings));
      break;
    }

    case "model/rerouted": {
      state.model = string(params.toModel) || state.model;
      break;
    }

    case "error": {
      recordError(state, event, turnId);

      break;
    }

    default: {
      break;
    }
  }

  updateActivity(state, event, turn);
}

/**
Reject foreign-thread notifications before mutating canonical state or activity.
@param state - Current parent snapshot owned by this bridge.
@param event - Validated native notification received from the transport.
*/
export function reduceEvent(state: Snapshot, event: RpcEvent) {
  if (event.params.threadId && event.params.threadId !== state.threadId) {
    return;
  }

  reduceScopedEvent(state, event);
}
