"use client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { clientError, reportClient } from "@/lib/client-logging";
import { get, post } from "@/lib/client-api";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

type Status = "loading" | "ready" | "subscribing" | "enabled" | "blocked" | "unsupported" | "dismissed";
const PREPARATION_TIMEOUT_MS = 5000;

async function readyRegistration() {
  await navigator.serviceWorker.register("/sw.js");

  return navigator.serviceWorker.ready;
}

async function prepareRegistration() {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      readyRegistration(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Open the installed Pocket app to enable notifications.")),
          PREPARATION_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function NotificationPrompt() {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const publicKey = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function prepare() {
      const config = await get("/api/notifications", controller.signal);

      if (!active) {
        return;
      }

      if (!("Notification" in globalThis) || !("PushManager" in globalThis) || !("serviceWorker" in navigator)) {
        setStatus("unsupported");

        return;
      }

      if (Notification.permission === "denied") {
        setStatus("blocked");

        return;
      }

      registration.current = await prepareRegistration();

      if (typeof config.publicKey !== "string") {
        throw new TypeError("Notification configuration is unavailable.");
      }

      const base64 = config.publicKey.replaceAll("-", "+").replaceAll("_", "/");
      publicKey.current = Uint8Array.from(atob(base64), (character) => character.codePointAt(0) ?? 0);
      let subscription = await registration.current.pushManager.getSubscription();

      if (subscription) {
        const key = subscription.options.applicationServerKey;

        if (
          !key ||
          new Uint8Array(key).some((value, index) => value !== publicKey.current?.[index]) ||
          key.byteLength !== publicKey.current.byteLength
        ) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }

      if (subscription) {
        await post("/api/notifications", subscription.toJSON());
      }

      if (active) {
        setStatus(subscription ? "enabled" : "ready");
      }
    }

    void prepare().catch((error_: unknown) => {
      reportClient("notifications.prepare_failed", clientError(error_), "error");

      if (!active) {
        return;
      }

      setError(error_ instanceof Error ? error_.message : "Couldn't prepare notifications.");
      setStatus("unsupported");
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  async function enable() {
    if (!registration.current || !publicKey.current) {
      return;
    }

    setStatus("subscribing");
    setError("");

    try {
      // Subscribe directly in the tap handler so Safari can present its permission dialog.
      const subscription = await registration.current.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey.current,
      });
      await post("/api/notifications", subscription.toJSON());
      setStatus("enabled");
    } catch (error_) {
      reportClient("notifications.subscribe_failed", clientError(error_), "error");
      setStatus(Notification.permission === "denied" ? "blocked" : "ready");
      setError("Couldn't enable notifications. Try again from the installed Pocket app.");
    }
  }

  if (["loading", "enabled", "dismissed"].includes(status)) {
    return null;
  }

  return (
    <Alert className="notification-prompt">
      <AlertDescription className="notification-content">
        <p>
          {error ||
            (status === "unsupported"
              ? "Add Pocket to your Home Screen to enable notifications."
              : status === "blocked"
                ? "Notifications are blocked. Enable them in your device settings."
                : "Get notified when Pocket finishes.")}
        </p>
        {(status === "ready" || status === "subscribing") && (
          <Button
            size="touch"
            disabled={status === "subscribing"}
            onClick={() => void enable()}
            aria-label="Enable notifications"
          >
            Enable
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xl"
          aria-label="Dismiss notification prompt"
          onClick={() => setStatus("dismissed")}
        >
          <XIcon />
        </Button>
      </AlertDescription>
    </Alert>
  );
}
