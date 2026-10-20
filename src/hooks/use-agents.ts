"use client";
import { useEffect, useState } from "react";
import { HTTP_FORBIDDEN } from "@/lib/constants";

const POLL_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

// Keep the last good read through reconnects, and never show another agent's data
// while its replacement request is loading. Polling cannot dispatch harness work.
export function useAgentRead<T>(url: string, schema: { parse: (value: unknown) => T }, isEnabled = true) {
  const [result, setResult] = useState<{ url: string; data?: T; error?: string }>({ url });

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    let isStopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;

    async function read() {
      const active = new AbortController();

      controller = active;
      const timeout = setTimeout(() => {
        active.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: active.signal,
        });

        if (!response.ok) {
          throw new Error(
            response.status === HTTP_FORBIDDEN
              ? "Access denied. Check Pocket access on your computer."
              : "Updates unavailable. Reconnecting automatically."
          );
        }

        const data = schema.parse(await response.json());

        if (!isStopped && controller === active) {
          setResult({ url, data });
        }
      } catch (error) {
        if (!isStopped && controller === active) {
          setResult((previous) => ({
            url,
            data: previous.url === url ? previous.data : undefined,
            error:
              error instanceof TypeError
                ? "Updates unavailable. Reconnecting automatically."
                : error instanceof Error && error.name !== "AbortError"
                  ? error.message
                  : "Updates timed out. Reconnecting automatically.",
          }));
        }
      } finally {
        clearTimeout(timeout);

        if (!isStopped && controller === active) {
          timer = setTimeout(() => void read(), POLL_MS);
        }
      }
    }

    const wake = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      clearTimeout(timer);
      controller?.abort();
      void read();
    };

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
  }, [url, schema, isEnabled]);

  return result.url === url ? result : { url };
}
