import { NotificationPresence } from "./notification-presence-state";

export { NotificationPresence, notificationDeviceId } from "./notification-presence-state";

declare global {
  var codexPocketNotificationPresence: NotificationPresence | undefined;
}

const presence = globalThis.codexPocketNotificationPresence ?? new NotificationPresence();

export const notificationPresence = presence;

if (!globalThis.codexPocketNotificationPresence) {
  Object.defineProperty(globalThis, "codexPocketNotificationPresence", {
    value: presence,
    configurable: true,
  });
}
