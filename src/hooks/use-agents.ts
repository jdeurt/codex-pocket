"use client";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { type ZodType } from "zod";

const POLL_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

interface AgentReadResult<T> {
  url: string;
  data?: T;
  error?: string;
}

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
@param receive - React state dispatcher that preserves data only for the same URL.
@returns Cleanup that cancels the request, timer and exact registered listeners.
*/
function subscribeAgentRead<T>(url: string, schema: ZodType<T>, receive: Dispatch<SetStateAction<AgentReadResult<T>>>) {
  let isStopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  async function readAndPublish(active: AbortController) {
    const data = await readAgentResponse(url, schema, active.signal);

    if (!isStopped && controller === active) {
      receive({ url, data });
    }
  }

  async function read() {
    const active = new AbortController();
    const timeout = setTimeout(() => {
      active.abort();
    }, REQUEST_TIMEOUT_MS);

    controller = active;

    try {
      await readAndPublish(active);
    } catch (error) {
      if (!isStopped && controller === active) {
        receive((previous) => ({
          url,
          data: previous.url === url ? previous.data : undefined,
          error: agentReadError(error),
        }));
      }
    } finally {
      clearTimeout(timeout);

      if (!isStopped && controller === active) {
        timer = setTimeout(() => void read(), POLL_MS);
      }
    }
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

/**
Poll a read-only agent endpoint while retaining the last good result for the same URL.
@param url - Scoped catalog or transcript GET endpoint.
@param schema - Shared Zod parser that validates each response once.
@param [isEnabled] - Whether this mounted view currently needs polling.
@returns The latest normalized data or recoverable read error for this URL.
*/
export function useAgentRead<T>(url: string, schema: ZodType<T>, isEnabled = true) {
  const [result, setResult] = useState<AgentReadResult<T>>({ url });

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    return subscribeAgentRead(url, schema, setResult);
  }, [url, schema, isEnabled]);

  return result.url === url ? result : { url };
}
