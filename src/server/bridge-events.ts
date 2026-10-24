import { t as captureResult } from "try";
import { type RpcEvent, type Snapshot } from "../lib/protocol";
import type { Config } from "./config";
import { contextUsageSchema } from "../lib/usage";
import { notifyTurnComplete } from "./push";
import { reduceEvent } from "./reducer";
import { requestFile } from "./request-files";
import { schedules } from "./schedules";
import { writeLocal } from "./local-state";

/** Persist the current request projection without rejecting the synchronous event reducer.
@param state - Parent snapshot whose pending requests have changed.
*/
export async function persistRequests(state: Snapshot) {
  const saved = await captureResult(writeLocal, requestFile(state.threadId), state.requests);

  if (!saved.ok) {
    console.error(saved.error);
  }
}

/** Deliver a completion notification independently of snapshot publication.
@param threadId - Owning conversation.
@param turn - Completed native turn.
*/
async function notifyCompletion(threadId: string, turn: Parameters<typeof notifyTurnComplete>[1]) {
  const sent = await captureResult(notifyTurnComplete, threadId, turn);

  if (!sent.ok) {
    console.error(sent.error);
  }
}

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
        void persistRequests(state);
        break;
      }

      case "serverRequest/resolved": {
        void persistRequests(state);
        break;
      }
    }

    if (config && event.method === "turn/completed" && event.params.turn) {
      const completed = event.params.turn;
      const turn = state.turns.find((entry) => entry.id === completed.id) ?? completed;

      void notifyCompletion(config.threadId, turn);
    }
  } else {
    state.requests.push({ ...event, id: event.id });
    void persistRequests(state);
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
