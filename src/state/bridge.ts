import { type RpcEvent, type Snapshot, type PendingRequest } from "../lib/protocol";
import { contextUsageSchema } from "../lib/usage";
import { reduceEvent } from "../server/reducer";

/** Remove requests completed by an explicit native turn.
@param requests - Pending native requests.
@param turnId - Completed native turn.
@returns Remaining requests in original order.
*/
function pendingTurnRequests(requests: readonly PendingRequest[], turnId: string | undefined) {
  const pending: PendingRequest[] = [];

  for (const request of requests) {
    if (request.params.turnId !== turnId) {
      pending.push(request);
    }
  }

  return pending;
}

/** Reduce native bridge state without publishing, persisting or reading the clock.
@param state - Previous canonical snapshot.
@param event - Parent-scoped native event.
@param now - Explicit event receipt timestamp.
@returns Next canonical snapshot.
*/
export function bridgeEventState(state: Snapshot, event: RpcEvent, now: number): Snapshot {
  if (event.id !== undefined) {
    return { ...state, requests: [...state.requests, { ...event, id: event.id }] };
  }

  const next = reduceEvent(state, event);

  switch (event.method) {
    case "thread/tokenUsage/updated": {
      const usage = contextUsageSchema.safeParse(event.params.tokenUsage);

      return usage.success ? { ...next, usage: usage.data } : next;
    }

    case "thread/compacted": {
      return { ...next, lastCompactionAt: now };
    }

    case "turn/completed": {
      return { ...next, requests: pendingTurnRequests(next.requests, event.params.turn?.id) };
    }

    default: {
      return next;
    }
  }
}

/** Convert durable occurrences into canonical schedule metadata.
@param runs - Explicit occurrence ledger entries.
@returns Noncancelled schedule metadata keyed by native delivery identity.
*/
export function snapshotSchedules(runs: readonly { id: string; title: string; scheduledAt: number; status: string }[]) {
  const scheduled: Snapshot["scheduled"] = {};

  for (const run of runs) {
    if (run.status !== "cancelled") {
      scheduled[run.id] = { title: run.title, scheduledAt: run.scheduledAt };
    }
  }

  return scheduled;
}
