import { createStore } from "zustand/vanilla";

export type NotificationStatus =
  "loading" | "ready" | "subscribing" | "enabled" | "blocked" | "unsupported" | "dismissed";

/** Create device notification state, without persisting permission claims or subscription resources.
@returns Shared status consumed by the notification UI and presence service.
*/
export function createNotificationStore() {
  return createStore<{ status: NotificationStatus; error: string; endpoint: string }>(() => ({
    status: "loading",
    error: "",
    endpoint: "",
  }));
}
