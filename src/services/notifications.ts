import { t } from "try";
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

  async function recordSubscription(subscription: PushSubscription | null, signal?: AbortSignal) {
    if (subscription) {
      await post("/api/notifications", subscription.toJSON());
    }

    signal?.throwIfAborted();
    setEndpoint(subscription?.endpoint ?? "");
    setStatus(subscription ? "enabled" : "ready");
  }

  const connect = () => {
    const controller = new AbortController();
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.endpoint === previous.endpoint) {
        return;
      }

      stopPresence?.();
      stopPresence = state.endpoint ? subscribeNotificationPresence(state.endpoint) : undefined;
    });

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
      await recordSubscription(await matchingSubscription(registration, publicKey), controller.signal);
    }

    async function initialize() {
      const prepared = await t(prepare);

      if (prepared.ok) {
        return;
      }

      reportClient("notifications.prepare_failed", clientError(prepared.error), "error");

      if (controller.signal.aborted) {
        return;
      }

      setError(prepared.error instanceof Error ? prepared.error.message : "Couldn't prepare notifications.");
      setStatus("unsupported");
    }

    void initialize();

    return () => {
      controller.abort();
      unsubscribe();
      stopPresence?.();
    };
  };

  async function enable() {
    const current = registration;
    const key = publicKey;

    if (!current || !key) {
      return;
    }

    setStatus("subscribing");
    setError("");
    // Invoke on the tap, before awaiting, so Safari retains user activation.
    const subscribed = await t(() =>
      current.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    );
    const saved = subscribed.ok ? await t(recordSubscription, subscribed.value) : subscribed;

    if (saved.ok) {
      return;
    }

    reportClient("notifications.subscribe_failed", clientError(saved.error), "error");
    setStatus(Notification.permission === "denied" ? "blocked" : "ready");
    setError("Couldn't enable notifications. Try again from the installed Pocket app.");
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
