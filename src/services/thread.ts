import { snapshotSchema, type Snapshot } from "../lib/protocol";
import { clientError, reportClient } from "../lib/client-logging";
import { SnapshotConnection } from "../lib/snapshot-connection";
import { ZodError } from "zod";
import { publishThread, type ThreadStore } from "../state/thread";
import { t as attempt } from "try";

/**
Decode each event once using the shared snapshot schema and retain distinct failure diagnostics.
@param text - Native EventSource message body.
@returns A normalized snapshot, or undefined after a JSON or schema failure is reported.
*/
function eventSnapshot(text: string) {
  const outcome = attempt(() => {
    return snapshotSchema.parse(JSON.parse(text));
  });

  if (outcome.ok) {
    return outcome.value;
  }

  const error = outcome.error;

  if (error instanceof ZodError) {
    reportClient("sse.invalid_state", { error: error.message }, "error");
  } else {
    reportClient("sse.invalid_json", clientError(error), "error");
  }
}

/**
Log accepted connection metadata only when its serialized summary changes.
@param state - Snapshot already validated at the event boundary.
@param previous - Last logged summary owned by this stream subscription.
@returns The summary to retain for the next accepted event.
*/
function logSnapshotSummary(state: Snapshot, previous: string) {
  const details = {
    connection: state.connection,
    activeTurnId: state.activeTurnId,
    model: state.model,
    effort: state.reasoningEffort,
    queued: state.queue.length,
    requests: state.requests.length,
  };
  const summary = JSON.stringify(details);

  if (summary !== previous) {
    reportClient("sse.state", details);
  }

  return summary;
}

/**
Open the shared parent event stream and own its reconnect and wake listeners.
@param store - Conversation state bound to this subscription.
@param url - Explicitly scoped events endpoint.
@returns Cleanup for the source, retry timer and native browser listeners.
*/
export function connectThread(store: ThreadStore, url: string) {
  let lastSummary = "";

  const connection = new SnapshotConnection(
    (text) => {
      const state = eventSnapshot(text);

      if (!state) {
        return false;
      }

      lastSummary = logSnapshotSummary(state, lastSummary);
      publishThread(store, state, true);

      return state.connection === "disconnected";
    },
    () => {
      publishThread(store, store.getState().latestState, false);
    },
    url
  );

  return () => {
    connection.stop();
  };
}
