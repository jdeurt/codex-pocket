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
  let timer: ReturnType<typeof setTimeout> | undefined;

  const completed = await captureResult(
    Promise.race([
      readyRegistration(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Open the installed Pocket app to enable notifications."));
        }, PREPARATION_TIMEOUT_MS);
      }),
    ])
  );

  clearTimeout(timer);

  if (!completed.ok) {
    throw completed.error;
  }

  return completed.value;
}

/**
Decode the configured VAPID key at the notification boundary.
@param value - Public key from the server's notification configuration.
@returns Native key bytes accepted by PushManager.
@throws {TypeError} When the server has no configured public key.
*/
export function notificationPublicKey(value: unknown) {
  if (typeof value !== "string") {
    throw new TypeError("Notification configuration is unavailable.");
  }

  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.codePointAt(0) ?? 0
  );
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

  if (
    subscription &&
    (!key ||
      new Uint8Array(key).some((value, index) => value !== publicKey[index]) ||
      key.byteLength !== publicKey.byteLength)
  ) {
    await subscription.unsubscribe();

    return null;
  }

  return subscription;
}
