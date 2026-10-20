"use client";
import { clientError, reportClient } from "@/lib/client-logging";
import { object, string } from "@/lib/protocol";
import { post } from "@/lib/client-api";
import { useEffect } from "react";

const HEX_RADIX = 16;

/**
Own the native presence source and visibility listeners for one subscribed device.
@param endpoint - Native push endpoint hashed into the existing device identifier.
@returns Cleanup that closes the source and prevents late digest completion from reconnecting.
*/
function subscribeNotificationPresence(endpoint: string) {
  let isActive = true;
  let source: EventSource | undefined;
  let deviceId = "";

  function close() {
    source?.close();
    source = undefined;
  }

  function answerProbe(data: string) {
    const challengeId = string(object(JSON.parse(data)).challengeId);

    if (challengeId) {
      void post("/api/notifications/presence", { deviceId, challengeId }).catch((error: unknown) => {
        reportClient("notifications.presence_failed", clientError(error), "error");
      });
    }
  }

  function receiveProbe(connection: EventSource, event: MessageEvent<string>) {
    if (source !== connection || document.visibilityState !== "visible") {
      return;
    }

    answerProbe(event.data);
  }

  function openPresenceSource() {
    const connection = new EventSource(`/api/notifications/presence?device=${deviceId}`);

    source = connection;
    connection.addEventListener("probe", (event: MessageEvent<string>) => {
      receiveProbe(connection, event);
    });
  }

  function connect() {
    close();

    if (!isActive || !deviceId || document.visibilityState !== "visible") {
      return;
    }

    openPresenceSource();
  }

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
    isActive = false;
    close();
    document.removeEventListener("visibilitychange", connect);
    globalThis.removeEventListener("pageshow", connect);
    globalThis.removeEventListener("pagehide", close);
    globalThis.removeEventListener("online", connect);
    globalThis.removeEventListener("offline", close);
  };
}

/**
Answer native presence probes only while this subscribed device is visible.
@param endpoint - Existing push-subscription endpoint whose digest identifies this device.
*/
export function useNotificationPresence(endpoint: string) {
  useEffect(() => {
    if (!endpoint) {
      return;
    }

    return subscribeNotificationPresence(endpoint);
  }, [endpoint]);
}
