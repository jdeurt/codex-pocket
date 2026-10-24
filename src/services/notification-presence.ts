import { t } from "try";
import { clientError, reportClient } from "@/lib/client-logging";
import { object, string } from "@/lib/protocol";
import { post } from "@/lib/client-api";

const HEX_RADIX = 16;

/**
Own the native presence source and visibility listeners for one subscribed device.
@param endpoint - Native push endpoint hashed into the existing device identifier.
@returns Cleanup that closes the source and prevents late digest completion from reconnecting.
*/
export function subscribeNotificationPresence(endpoint: string) {
  let isActive = true;
  let source: EventSource | undefined;
  let deviceId = "";

  function close() {
    source?.close();
    source = undefined;
  }

  async function answerProbe(data: string) {
    const challengeId = string(object(JSON.parse(data)).challengeId);

    if (!challengeId) {
      return;
    }

    const sent = await t(post, "/api/notifications/presence", { deviceId, challengeId });

    if (!sent.ok) {
      reportClient("notifications.presence_failed", clientError(sent.error), "error");
    }
  }

  function receiveProbe(connection: EventSource, event: MessageEvent<string>) {
    if (source !== connection || document.visibilityState !== "visible") {
      return;
    }

    void answerProbe(event.data);
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

  async function identifyDevice() {
    const result = await t(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));

    if (!result.ok) {
      reportClient("notifications.presence_failed", clientError(result.error), "error");

      return;
    }

    deviceId = [...new Uint8Array(result.value)].map((value) => value.toString(HEX_RADIX).padStart(2, "0")).join("");
    connect();
  }

  void identifyDevice();
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
