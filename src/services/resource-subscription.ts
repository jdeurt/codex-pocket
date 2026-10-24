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
Own request timeouts, polling and wake listeners for one enabled agent view.
@param url - Stable scoped endpoint for this subscription.
@param schema - Shared schema whose output is retained by React.
@param store - Observable state owned by this URL and Pocket.
@returns Cleanup that cancels the request, timer and exact registered listeners.
*/
export function subscribeResource<T>(url: string, schema: ZodType<T>, store: StoreApi<ResourceState<T>>) {
  let isStopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  async function read() {
    const active = new AbortController();
    const timeout = setTimeout(() => {
      active.abort();
    }, REQUEST_TIMEOUT_MS);

    controller = active;
    store.setState({ isLoading: true });

    const result = await t(readAgentResponse<T>, url, schema, active.signal);

    clearTimeout(timeout);

    if (isStopped || controller !== active) {
      return;
    }

    store.setState(
      result.ok
        ? { data: result.value, error: undefined, isLoading: false }
        : { error: agentReadError(result.error), isLoading: false }
    );
    timer = setTimeout(() => void read(), POLL_MS);
  }

  function wake() {
    if (document.visibilityState !== "visible") {
      return;
    }

    clearTimeout(timer);
    controller?.abort();
    void read();
  }

  void read();
  globalThis.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);

  return () => {
    isStopped = true;
    clearTimeout(timer);
    controller?.abort();
    globalThis.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake);
  };
}
