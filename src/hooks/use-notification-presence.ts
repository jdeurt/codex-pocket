"use client";
import { clientError, reportClient } from "@/lib/client-logging";
import { object, string } from "@/lib/protocol";
import { post } from "@/lib/client-api";
import { useEffect } from "react";

const HEX_RADIX = 16;

export function useNotificationPresence(endpoint: string) {
  useEffect(() => {
    if (!endpoint) {
      return;
    }

    let active = true;
    let source: EventSource | undefined;
    let deviceId = "";

    const close = () => {
      source?.close();
      source = undefined;
    };
    const connect = () => {
      close();

      if (!active || !deviceId || document.visibilityState !== "visible") {
        return;
      }

      const connection = new EventSource(`/api/notifications/presence?device=${deviceId}`);

      source = connection;
      connection.addEventListener("probe", (event: MessageEvent<string>) => {
        if (source !== connection || document.visibilityState !== "visible") {
          return;
        }

        const challengeId = string(object(JSON.parse(event.data)).challengeId);

        if (challengeId) {
          void post("/api/notifications/presence", { deviceId, challengeId }).catch((error: unknown) => {
            reportClient("notifications.presence_failed", clientError(error), "error");
          });
        }
      });
    };

    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)).then((digest) => {
      deviceId = [...new Uint8Array(digest)].map((value) => value.toString(HEX_RADIX).padStart(2, "0")).join("");
      connect();
    });
    document.addEventListener("visibilitychange", connect);
    globalThis.addEventListener("pageshow", connect);
    globalThis.addEventListener("pagehide", close);
    globalThis.addEventListener("online", connect);
    globalThis.addEventListener("offline", close);

    return () => {
      active = false;
      close();
      document.removeEventListener("visibilitychange", connect);
      globalThis.removeEventListener("pageshow", connect);
      globalThis.removeEventListener("pagehide", close);
      globalThis.removeEventListener("online", connect);
      globalThis.removeEventListener("offline", close);
    };
  }, [endpoint]);
}
