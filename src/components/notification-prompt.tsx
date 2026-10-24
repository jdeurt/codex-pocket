"use client";
import { requestNotifications } from "../runtime/notification-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "./ui/button";
import { XIcon } from "lucide-react";
import { useStore } from "zustand";
import { usePocketClient } from "../providers/pocket-state";
import { type NotificationStatus as Status } from "../state/notifications";

const statusMessages: Partial<Record<Status, string>> = {
  unsupported: "Add Pocket to your Home Screen to enable notifications.",
  blocked: "Notifications are blocked. Enable them in your device settings.",
};

/** Render notification state and explicit permission actions.
@returns Device notification prompt; services own registration and presence.
*/
export function NotificationPrompt() {
  const { notifications } = usePocketClient();
  const { status, error } = useStore(notifications.store);
  const { dismiss } = notifications;

  if (["loading", "enabled", "dismissed"].includes(status)) {
    return null;
  }

  return (
    <Alert className="notification-prompt">
      <AlertDescription className="notification-content">
        <p>{error || (statusMessages[status] ?? "Get notified when Pocket finishes.")}</p>
        {(status === "ready" || status === "subscribing") && (
          <Button
            size="touch"
            disabled={status === "subscribing"}
            onClick={requestNotifications.bind(undefined, notifications)}
            aria-label="Enable notifications"
          >
            Enable
          </Button>
        )}
        <Button variant="ghost" size="icon-xl" aria-label="Dismiss notification prompt" onClick={dismiss}>
          <XIcon />
        </Button>
      </AlertDescription>
    </Alert>
  );
}
