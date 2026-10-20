import { type RpcEvent, type Snapshot } from "../lib/protocol";
import type { Config } from "./config";
import { contextUsageSchema } from "../lib/usage";
import { notifyTurnComplete } from "./push";
import { reduceEvent } from "./reducer";
import { requestFile } from "./request-files";
import { schedules } from "./schedules";
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

    switch (event.method) {
      case "thread/tokenUsage/updated": {
        const usage = contextUsageSchema.safeParse(event.params.tokenUsage);

        if (usage.success) {
          state.usage = usage.data;
        }

        break;
      }

      case "thread/compacted": {
        state.lastCompactionAt = Date.now();
        break;
      }

      case "turn/completed": {
        state.requests = state.requests.filter((r) => r.params.turnId !== event.params.turn?.id);
        void writeLocal(requestFile(state.threadId), state.requests).catch(console.error);
        break;
      }

      case "serverRequest/resolved": {
        void writeLocal(requestFile(state.threadId), state.requests).catch(console.error);
        break;
      }
    }

    if (config && event.method === "turn/completed" && event.params.turn) {
      const completed = event.params.turn;
      const turn = state.turns.find((entry) => entry.id === completed.id) ?? completed;

      void notifyTurnComplete(config.threadId, turn).catch(console.error);
    }
  } else {
    state.requests.push({ ...event, id: event.id });
    void writeLocal(requestFile(state.threadId), state.requests).catch(console.error);
    console.info(`\nCodex needs input on this computer: ${event.method}\nRun: npm run desktop -- requests\n`);
  }
}

/**
Project pending schedule metadata into the canonical parent snapshot.
@param state - Existing canonical parent state.
@param config - Server-owned parent configuration, absent before setup.
*/
export function refreshSnapshotSchedules(state: Snapshot, config?: Config) {
  if (config) {
    state.scheduled = Object.fromEntries(
      schedules()
        .occurrences.list(config.threadId)
        .filter((run) => run.status !== "cancelled")
        .map((run) => [run.id, { title: run.title, scheduledAt: run.scheduledAt }])
    );
  }
}
