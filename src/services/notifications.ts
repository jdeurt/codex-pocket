import { notificationState, notificationPublicKey } from "../state/notifications";
import { t } from "try";
import { observable } from "../runtime/stores";
import { clientError, reportClient } from "../runtime/client-logging";
import { get, post } from "../runtime/client-api";
import { matchingSubscription, prepareRegistration } from "./notification-registration";
import { subscribeNotificationPresence } from "./notification-presence";

/** Invoke PushManager synchronously in the user's activation task.
@param registration - Ready native worker registration.
@param key - Validated VAPID public key.
@returns Native subscription completion.
*/
function subscribePush(registration: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>) {
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/**
Runtime owner of native notification permission, subscription and device presence.
*/
export class NotificationController {
  private registration: ServiceWorkerRegistration | null = null;
  private publicKey: Uint8Array<ArrayBuffer> | null = null;
  private stopPresence: (() => void) | undefined;
  private controller: AbortController | undefined;
  private unsubscribe: (() => void) | undefined;

  /** Persist the native subscription before publishing its endpoint.
  @param subscription - Existing or newly allocated native subscription.
  @param signal - Optional mounted-lifetime cancellation.
  */
  private recordSubscription = async (subscription: PushSubscription | null, signal?: AbortSignal) => {
    if (subscription) {
      await post("/api/notifications", subscription.toJSON());
    }

    signal?.throwIfAborted();
    this.store.setState({ endpoint: subscription?.endpoint ?? "", status: subscription ? "enabled" : "ready" });
  };

  /** Replace device presence when a published native endpoint changes.
  @param current - Current endpoint projection.
  @param previous - Previous endpoint projection.
  */
  private endpointChanged = (current: { endpoint: string }, previous: { endpoint: string }) => {
    if (current.endpoint === previous.endpoint) {
      return;
    }

    this.stopPresence?.();
    this.stopPresence = current.endpoint ? subscribeNotificationPresence(current.endpoint) : undefined;
  };

  /** Check native capabilities and restore the existing subscription.
  @param controller - Exact lifetime owning this asynchronous preparation.
  */
  private prepare = async (controller: AbortController) => {
    const config = await get("/api/notifications", controller.signal);

    controller.signal.throwIfAborted();

    if (!("Notification" in globalThis) || !("PushManager" in globalThis) || !("serviceWorker" in navigator)) {
      this.store.setState({ status: "unsupported" });

      return;
    }

    if (Notification.permission === "denied") {
      this.store.setState({ status: "blocked" });

      return;
    }

    const registration = await prepareRegistration();

    controller.signal.throwIfAborted();
    this.registration = registration;
    this.publicKey = notificationPublicKey(config.publicKey);
    await this.recordSubscription(await matchingSubscription(registration, this.publicKey), controller.signal);
  };

  /** Capture preparation errors without publishing after disposal.
  @param controller - Exact mounted lifetime.
  */
  private initialize = async (controller: AbortController) => {
    const prepared = await t(this.prepare, controller);

    if (prepared.ok) {
      return;
    }

    reportClient("notifications.prepare_failed", clientError(prepared.error), "error");

    if (!controller.signal.aborted) {
      this.store.setState({
        error: prepared.error instanceof Error ? prepared.error.message : "Couldn't prepare notifications.",
        status: "unsupported",
      });
    }
  };

  /**
  Release preparation, state subscription and device presence.
  */
  private disconnect = () => {
    this.controller?.abort();
    this.unsubscribe?.();
    this.stopPresence?.();
  };

  readonly store = observable(notificationState());

  /** Start the notification lifetime after mount.
  @returns Cleanup for native preparation and presence.
  */
  connect = () => {
    this.controller = new AbortController();
    this.unsubscribe = this.store.subscribe(this.endpointChanged);
    void this.initialize(this.controller);

    return this.disconnect;
  };

  /**
  Request permission on the user's tap and persist the resulting subscription.
  */
  enable = async () => {
    if (!this.registration || !this.publicKey) {
      return;
    }

    this.store.setState({ status: "subscribing", error: "" });
    const subscribed = await t(subscribePush, this.registration, this.publicKey);
    const saved = subscribed.ok ? await t(this.recordSubscription, subscribed.value) : subscribed;

    if (saved.ok) {
      return;
    }

    reportClient("notifications.subscribe_failed", clientError(saved.error), "error");
    this.store.setState({
      status: Notification.permission === "denied" ? "blocked" : "ready",
      error: "Couldn't enable notifications. Try again from the installed Pocket app.",
    });
  };

  /**
  Dismiss the local permission prompt without changing native permission.
  */
  dismiss = () => {
    this.store.setState({ status: "dismissed" });
  };
}
