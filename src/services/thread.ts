import { snapshotSchema, type Snapshot } from "../lib/protocol";
import { clientError, reportClient } from "../runtime/client-logging";
import { SnapshotConnection } from "../runtime/snapshot-connection";
import { ZodError } from "zod";
import { publishThread, type ThreadStore } from "../runtime/stores";
import { t as attempt } from "try";

/** Decode an event using only its explicit payload and immutable schema.
@param text - Native EventSource body.
@returns Validated canonical snapshot.
*/
function parseSnapshot(text: string) {
  return snapshotSchema.parse(JSON.parse(text));
}

/** Validate a received event and report boundary failures.
@param text - Native EventSource body.
@returns Accepted snapshot, or undefined after reporting invalid data.
*/
function eventSnapshot(text: string) {
  const outcome = attempt(parseSnapshot, text);

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

/** Log changed connection metadata at the stream boundary.
@param state - Accepted snapshot.
@param previous - Last logged summary owned by this subscription.
@returns Serialized summary to retain for the next event.
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
Runtime owner of a stream and its logging/publication effects.
*/
class ThreadSubscription {
  private lastSummary = "";
  private readonly connection: SnapshotConnection;

  /** Accept an event and publish the pure reconciliation result.
  @param text - Native stream payload.
  @returns Whether the native agent has disconnected.
  */
  private receive = (text: string) => {
    const state = eventSnapshot(text);

    if (!state) {
      return false;
    }

    this.lastSummary = logSnapshotSummary(state, this.lastSummary);
    publishThread(this.store, state, true);

    return state.connection === "disconnected";
  };

  /**
  Publish transport loss without discarding canonical history.
  */
  private disconnected = () => {
    publishThread(this.store, this.store.getState().latestState, false);
  };

  /**
  Release the stream, wake listeners and retry timer.
  */
  stop = () => {
    this.connection.stop();
  };

  /** Open a scoped stream using stable, owner-bound callbacks.
  @param store - Explicit conversation runtime.
  @param url - Scoped stream endpoint.
  */
  constructor(
    private readonly store: ThreadStore,
    url: string
  ) {
    this.connection = new SnapshotConnection(this.receive, this.disconnected, url);
  }
}

/** Open the shared parent stream at the effect boundary.
@param store - Conversation runtime owner.
@param url - Scoped events endpoint.
@returns Cleanup for this subscription.
*/
export function connectThread(store: ThreadStore, url: string) {
  return new ThreadSubscription(store, url).stop;
}
