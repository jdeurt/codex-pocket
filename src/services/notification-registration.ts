import { areNotificationKeysEqual } from "../state/notifications";
import { t as captureResult } from "try";

const PREPARATION_TIMEOUT_MS = 5000;

/**
Register the existing worker and wait until its native registration is active.
@returns The ready native service-worker registration.
*/
async function readyRegistration() {
  await navigator.serviceWorker.register("/sw.js");

  return navigator.serviceWorker.ready;
}

/**
Bound native worker preparation and clear its timeout after either outcome.
@returns The ready registration before the preparation deadline.
@throws {Error} When worker preparation fails or exceeds the existing deadline.
*/
export async function prepareRegistration() {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    deadline.reject,
    PREPARATION_TIMEOUT_MS,
    new Error("Open the installed Pocket app to enable notifications.")
  );
  const completed = await captureResult(Promise.race([readyRegistration(), deadline.promise]));

  clearTimeout(timer);

  if (!completed.ok) {
    throw completed.error;
  }

  return completed.value;
}

/**
Keep an existing native subscription only when it uses the currently configured VAPID key.
@param registration - Ready native worker registration.
@param publicKey - Configured VAPID bytes, compared with the browser's actual subscription key.
@returns The existing matching subscription, or null after removing an obsolete one.
*/
export async function matchingSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: Uint8Array<ArrayBuffer>
) {
  const subscription = await registration.pushManager.getSubscription();
  const key = subscription?.options.applicationServerKey;

  if (subscription && !areNotificationKeysEqual(key, publicKey)) {
    await subscription.unsubscribe();

    return null;
  }

  return subscription;
}
