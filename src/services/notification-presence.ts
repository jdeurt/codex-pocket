import { t } from "try";
import { clientError, reportClient } from "../runtime/client-logging";
import { object, string } from "@/lib/protocol";
import { post } from "../runtime/client-api";
import { notificationDeviceId } from "../state/notifications";
import { EventBindings } from "../runtime/events";

/** Derive a device identity at the cryptographic runtime boundary.
@param endpoint - Native push subscription endpoint.
@returns Stable hexadecimal device identity.
*/
async function deviceIdentity(endpoint: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));

  return notificationDeviceId(new Uint8Array(digest));
}

/**
Runtime owner of one device's native presence connection and visibility listeners.
*/
class NotificationPresence {
  private isActive = true;
  private source: EventSource | undefined;
  private deviceId = "";
  private readonly events: EventBindings;

  /**
  Close this owner's current source before a visibility change or teardown.
  */
  private close = () => {
    this.source?.close();
    this.source = undefined;
  };

  /** Decode and answer one provider probe at the network boundary.
  @param data - Serialized probe payload.
  */
  private answerProbe = async (data: string) => {
    const challengeId = string(object(JSON.parse(data)).challengeId);

    if (challengeId) {
      await post("/api/notifications/presence", { deviceId: this.deviceId, challengeId });
    }
  };

  /** Capture decoding and delivery failures for native probe callbacks.
  @param data - Serialized probe payload.
  */
  private deliverProbe = async (data: string) => {
    const sent = await t(this.answerProbe, data);

    if (!sent.ok) {
      reportClient("notifications.presence_failed", clientError(sent.error), "error");
    }
  };

  /** Ignore stale sources and probes received while the tab is hidden.
  @param event - Native probe event.
  */
  private receiveProbe = (event: MessageEvent<string>) => {
    if (event.currentTarget === this.source && document.visibilityState === "visible") {
      void this.deliverProbe(event.data);
    }
  };

  /**
  Reopen presence only when the current browser lifecycle permits it.
  */
  private connect = () => {
    this.close();

    if (!(this.isActive && this.deviceId && document.visibilityState === "visible")) {
      return;
    }

    this.source = new EventSource(`/api/notifications/presence?device=${this.deviceId}`);
    this.source.addEventListener("probe", this.receiveProbe);
  };

  /** Derive the device identity, respecting disposal during asynchronous hashing.
  @param endpoint - Push subscription endpoint.
  */
  private identify = async (endpoint: string) => {
    const result = await t(deviceIdentity, endpoint);

    if (result.ok) {
      this.deviceId = result.value;
      this.connect();
    } else {
      reportClient("notifications.presence_failed", clientError(result.error), "error");
    }
  };

  /**
  Invalidate late hashing and release source/listener resources.
  */
  stop = () => {
    this.isActive = false;
    this.close();
    this.events.stop();
  };

  /** Start presence effects for one native subscription.
  @param endpoint - Push subscription endpoint.
  */
  constructor(endpoint: string) {
    this.events = new EventBindings([
      [document, "visibilitychange", this.connect],
      [globalThis, "pageshow", this.connect],
      [globalThis, "pagehide", this.close],
      [globalThis, "online", this.connect],
      [globalThis, "offline", this.close],
    ]);
    void this.identify(endpoint);
  }
}

/** Subscribe one device to host presence notifications.
@param endpoint - Native push subscription endpoint.
@returns Cleanup for the runtime owner.
*/
export function subscribeNotificationPresence(endpoint: string) {
  return new NotificationPresence(endpoint).stop;
}
