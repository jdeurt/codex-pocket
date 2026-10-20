import { type RpcEvent, type Snapshot } from "../lib/protocol";
import type { Config } from "./config";
import { contextUsageSchema } from "../lib/usage";
import { notifyTurnComplete } from "./push";
import { reduceEvent } from "./reducer";
import { writeLocal } from "./local-state";

/**
Apply one parent-scoped native event and retain durable request and completion effects.
@param state - Canonical hydrated parent state.
@param config - Parent configuration, when available.
@param event - Validated native event already scoped by the connection owner.
*/
export function applyBridgeEvent(state: Snapshot, config: Config | undefined, event: RpcEvent) {
  if (event.id === undefined) {
    reduceEvent(state, event);

    if (event.method === "thread/tokenUsage/updated") {
      const usage = contextUsageSchema.safeParse(event.params.tokenUsage);

      if (usage.success) {
        state.usage = usage.data;
      }
    }

    if (event.method === "thread/compacted") {
      state.lastCompactionAt = Date.now();
    }

    if (event.method === "serverRequest/resolved" || event.method === "turn/completed") {
      if (event.method === "turn/completed") {
        state.requests = state.requests.filter((r) => r.params.turnId !== event.params.turn?.id);
      }

      void writeLocal("requests.json", state.requests).catch(console.error);
    }

    if (config && event.method === "turn/completed" && event.params.turn) {
      const completed = event.params.turn;
      const turn = state.turns.find((entry) => entry.id === completed.id) ?? completed;

      void notifyTurnComplete(config.threadId, turn).catch(console.error);
    }
  } else {
    state.requests.push({ ...event, id: event.id });
    void writeLocal("requests.json", state.requests).catch(console.error);
    console.info(`\nCodex needs input on this computer: ${event.method}\nRun: npm run desktop -- requests\n`);
  }
}
