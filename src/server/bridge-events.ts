import { t as captureResult } from "try";
import { type RpcEvent, type Snapshot } from "../lib/protocol";
import type { Config } from "./config";
import { bridgeEventState, snapshotSchedules } from "../state/bridge";
import { findById } from "../lib/identity";
import { notifyTurnComplete } from "./push";
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
@returns Next canonical snapshot after scheduling its independent effects.
*/
export function applyBridgeEvent(state: Snapshot, config: Config | undefined, event: RpcEvent) {
  const next = bridgeEventState(state, event, Date.now());

  if (event.id !== undefined || event.method === "turn/completed" || event.method === "serverRequest/resolved") {
    void persistRequests(next);
  }

  if (config && event.id === undefined && event.method === "turn/completed" && event.params.turn) {
    const turn = findById(next.turns, event.params.turn.id) ?? event.params.turn;

    void notifyCompletion(config.threadId, turn);
  }

  if (event.id !== undefined) {
    console.info(`\nCodex needs input on this computer: ${event.method}\nRun: npm run desktop -- requests\n`);
  }

  return next;
}

/**
Project pending schedule metadata into the canonical parent snapshot.
@param state - Existing canonical parent state.
@param config - Server-owned parent configuration, absent before setup.
@returns Snapshot containing current durable schedule metadata.
*/
export function refreshSnapshotSchedules(state: Snapshot, config?: Config) {
  return config ? { ...state, scheduled: snapshotSchedules(schedules().occurrences.list(config.threadId)) } : state;
}
