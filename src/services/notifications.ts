import { createNotificationStore, type NotificationStatus } from "../state/notifications";
import { clientError, reportClient } from "../lib/client-logging";
import { get, post } from "../lib/client-api";
import { matchingSubscription, notificationPublicKey, prepareRegistration } from "./notification-registration";
import { subscribeNotificationPresence } from "./notification-presence";

/** Own notification permission, registration and device presence outside rendering.
@returns Shared observable state and browser lifecycle actions.
*/
export function createNotificationController() {
  const store = createNotificationStore();
  const setStatus = (status: NotificationStatus) => {
    store.setState({ status });
  };
  const setError = (error: string) => {
    store.setState({ error });
  };
  const setEndpoint = (endpoint: string) => {
    store.setState({ endpoint });
  };

  let registration: ServiceWorkerRegistration | null = null;
  let publicKey: Uint8Array<ArrayBuffer> | null = null;
  let stopPresence: (() => void) | undefined;

  const connect = () => {
    const controller = new AbortController();
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.endpoint === previous.endpoint) {
        return;
      }

      stopPresence?.();
      stopPresence = state.endpoint ? subscribeNotificationPresence(state.endpoint) : undefined;
    });

    async function restoreSubscription(nativeRegistration: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>) {
      const subscription = await matchingSubscription(nativeRegistration, key);

      if (subscription) {
        await post("/api/notifications", subscription.toJSON());
      }

      controller.signal.throwIfAborted();
      setEndpoint(subscription?.endpoint ?? "");
      setStatus(subscription ? "enabled" : "ready");
    }

    async function prepare() {
      const config = await get("/api/notifications", controller.signal);

      controller.signal.throwIfAborted();

      if (!("Notification" in globalThis) || !("PushManager" in globalThis) || !("serviceWorker" in navigator)) {
        setStatus("unsupported");

        return;
      }

      if (Notification.permission === "denied") {
        setStatus("blocked");

        return;
      }

      registration = await prepareRegistration();

      publicKey = notificationPublicKey(config.publicKey);
      await restoreSubscription(registration, publicKey);
    }

    void prepare().catch((error_: unknown) => {
      reportClient("notifications.prepare_failed", clientError(error_), "error");

      if (controller.signal.aborted) {
        return;
      }

      setError(error_ instanceof Error ? error_.message : "Couldn't prepare notifications.");
      setStatus("unsupported");
    });

    return () => {
      controller.abort();
      unsubscribe();
      stopPresence?.();
    };
  };

  async function enable() {
    if (!registration || !publicKey) {
      return;
    }

    setStatus("subscribing");
    setError("");

    await (async () => {
      // Subscribe directly in the tap handler so Safari can present its permission dialog.
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });

      await post("/api/notifications", subscription.toJSON());
      setEndpoint(subscription.endpoint);
      setStatus("enabled");
    })().catch((error_: unknown) => {
      reportClient("notifications.subscribe_failed", clientError(error_), "error");
      setStatus(Notification.permission === "denied" ? "blocked" : "ready");
      setError("Couldn't enable notifications. Try again from the installed Pocket app.");
    });
  }

  return {
    store,
    connect,
    enable,
    dismiss: () => {
      setStatus("dismissed");
    },
  };
}
