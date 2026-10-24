import { EventBindings } from "../runtime/events";
import { t } from "try";
import { HTTP_FORBIDDEN } from "../lib/constants";
import { type ZodType } from "zod";
import { type StoreApi } from "zustand/vanilla";
import { type ResourceState } from "../state/resource";

const POLL_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
Read one scoped agent endpoint and validate its response with the shared protocol schema.
@param url - Catalog or transcript GET endpoint.
@param schema - Actual Zod schema for the endpoint's normalized result.
@param signal - Cancellation signal owned by this polling request.
@returns The validated response, without dispatching harness work.
*/
async function readAgentResponse<T>(url: string, schema: ZodType<T>, signal: AbortSignal) {
  const response = await fetch(url, { cache: "no-store", signal });

  if (!response.ok) {
    throw new Error(
      response.status === HTTP_FORBIDDEN
        ? "Access denied. Check Pocket access on your computer."
        : "Updates unavailable. Reconnecting automatically."
    );
  }

  return schema.parse(await response.json());
}

/**
Keep network, abort and protocol failures consistent with the existing reconnect presentation.
@param error - Rejection received from a native fetch or shared protocol parser.
@returns The existing recoverable error label.
*/
function agentReadError(error: unknown) {
  if (error instanceof TypeError) {
    return "Updates unavailable. Reconnecting automatically.";
  }

  return error instanceof Error && error.name !== "AbortError"
    ? error.message
    : "Updates timed out. Reconnecting automatically.";
}

/**
Explicit runtime owner of polling, cancellation and wake listeners.
*/
class ResourceSubscription<T> {
  private readonly events: EventBindings;
  private isStopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;

  /** Read and publish one resource while rejecting stale requests.
  @returns Completion after the next poll is scheduled.
  */
  private read = async () => {
    const active = new AbortController();

    this.controller = active;
    this.store.setState({ isLoading: true });
    const signal = AbortSignal.any([active.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const result = await t(readAgentResponse<T>, this.url, this.schema, signal);

    if (this.isStopped || this.controller !== active) {
      return;
    }

    this.store.setState(
      result.ok
        ? { data: result.value, error: undefined, isLoading: false }
        : { error: agentReadError(result.error), isLoading: false }
    );
    this.timer = setTimeout(this.reload, POLL_MS);
  };

  /**
  Schedule a read from a native timer callback.
  */
  private reload = () => {
    void this.read();
  };

  /**
  Refresh visible consumers after a browser wake or reconnect.
  */
  private wake = () => {
    if (document.visibilityState !== "visible") {
      return;
    }

    clearTimeout(this.timer);
    this.controller?.abort();
    this.reload();
  };

  /**
  Release the request, poll timer and exact registered callbacks.
  */
  stop = () => {
    this.isStopped = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.events.stop();
  };

  /** Open the runtime subscription after its consumer mounts.
  @param url - Scoped resource endpoint.
  @param schema - Response validator.
  @param store - Explicit observable resource owner.
  */
  constructor(
    private readonly url: string,
    private readonly schema: ZodType<T>,
    private readonly store: StoreApi<ResourceState<T>>
  ) {
    this.reload();
    this.events = new EventBindings([
      [globalThis, "online", this.wake],
      [document, "visibilitychange", this.wake],
    ]);
  }
}

/** Open polling at the service boundary with explicit state and network dependencies.
@param url - Scoped API endpoint.
@param schema - Response validator.
@param store - Observable resource owner.
@returns Cleanup for this subscription.
*/
export function subscribeResource<T>(url: string, schema: ZodType<T>, store: StoreApi<ResourceState<T>>) {
  return new ResourceSubscription(url, schema, store).stop;
}
