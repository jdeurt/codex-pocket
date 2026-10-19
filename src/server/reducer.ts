import { type Item, type RpcEvent, type Snapshot, type Turn, object, pretty, string } from "../lib/protocol";
import { updateActivity } from "./activity";

const MISSING_INDEX = -1;

function updateSettings(state: Snapshot, settings: Record<string, unknown>) {
  state.model = string(settings.model) || state.model;

  if (typeof settings.effort === "string" || settings.effort === null) {
    state.reasoningEffort = settings.effort;
  }
}

export function reduceEvent(state: Snapshot, event: RpcEvent) {
  const params = event.params;

  if (params.threadId && params.threadId !== state.threadId) {
    return;
  }

  const turnId = string(params.turnId) || string(object(params.turn).id);
  let turn = state.turns.find((entry) => entry.id === turnId);

  switch (event.method) {
    case "turn/started": {
      const incoming = params.turn as Turn;

      if (!turn) {
        turn = { ...incoming, items: incoming.items ?? [] };
        state.turns.push(turn);
      }

      turn.status = "inProgress";
      state.activeTurnId = turn.id;
      state.activity = "Considering options";
      state.error = undefined;
      break;
    }

    case "turn/completed": {
      const incoming = params.turn as Turn;

      if (turn) {
        turn.status = incoming.status;
        turn.error = incoming.error;
      }

      if (state.activeTurnId === incoming.id) {
        state.activeTurnId = undefined;
        state.activity = undefined;
      }

      if (incoming.error) {
        state.error = incoming.error.message;
      }

      break;
    }

    case "item/started":
    case "item/completed": {
      if (!turn) {
        turn = { id: turnId, status: "inProgress", items: [] };
        state.turns.push(turn);
      }

      const item = params.item as Item;
      const index = turn.items.findIndex((entry) => entry.id === item.id);

      if (index === MISSING_INDEX) {
        turn.items.push(item);
      } else {
        turn.items[index] = { ...turn.items[index], ...item };
      }

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
      state.error = string(object(params.error).message) || string(params.message) || pretty(params);
      break;
    }

    default: {
      break;
    }
  }

  updateActivity(state, event, turn);
}
