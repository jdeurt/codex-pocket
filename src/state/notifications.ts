export type NotificationStatus =
  "loading" | "ready" | "subscribing" | "enabled" | "blocked" | "unsupported" | "dismissed";

/** Create device notification data without checking browser permissions.
@returns Initial notification projection.
*/
export function notificationState(): { status: NotificationStatus; error: string; endpoint: string } {
  return { status: "loading", error: "", endpoint: "" };
}

/** Decode an explicitly supplied VAPID public key without reading browser state.
@param value - Public key from validated server configuration.
@returns Native key bytes accepted by PushManager.
*/
export function notificationPublicKey(value: unknown) {
  if (typeof value !== "string") {
    throw new TypeError("Notification configuration is unavailable.");
  }

  const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.codePointAt(index) ?? 0;
  }

  return bytes;
}

/** Compare supplied key bytes without reading a native subscription.
@param saved - Existing key bytes, if present.
@param configured - Current configured key.
@returns Whether both keys contain the same bytes.
*/
export function areNotificationKeysEqual(saved: ArrayBuffer | null | undefined, configured: Uint8Array) {
  if (saved?.byteLength !== configured.byteLength) {
    return false;
  }

  const bytes = new Uint8Array(saved);

  for (const [index, byte] of bytes.entries()) {
    if (byte !== configured[index]) {
      return false;
    }
  }

  return true;
}

/** Format explicitly supplied digest bytes as a deterministic device identity.
@param bytes - Cryptographic digest computed by the runtime.
@returns Lowercase hexadecimal identity.
*/
export function notificationDeviceId(bytes: Uint8Array) {
  const radix = 16;

  let identity = "";

  for (const byte of bytes) {
    identity += byte.toString(radix).padStart(2, "0");
  }

  return identity;
}
