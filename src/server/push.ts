import { readLocal, writeLocal } from "./local-state";
import webpush, { type PushSubscription, type VapidKeys } from "web-push";
import type { Turn } from "../lib/protocol";
import { readConfig } from "./config";
import { z } from "zod";

const PUSH_TIMEOUT_MS = 10_000;
const PUSH_TTL_SECONDS = 3600;
const RECEIPT_LIMIT = 1000;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const MAX_ENDPOINT_LENGTH = 4096;
const EXPIRED_SUBSCRIPTION_STATUSES = new Set([HTTP_NOT_FOUND, HTTP_GONE]);

export const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(MAX_ENDPOINT_LENGTH)
    .refine((value) => new URL(value).protocol === "https:"),
  keys: z.object({
    p256dh: z.string().regex(/^[\w-]{87}=$|^[\w-]{87}$/),
    auth: z.string().regex(/^[\w-]{22}==$|^[\w-]{22}$/),
  }),
});

interface PushState {
  keys: VapidKeys;
  subscriptions: PushSubscription[];
  notified: string[];
}

declare global {
  var codexPocketPush: { serial: Promise<unknown> } | undefined;
}

if (!globalThis.codexPocketPush) {
  Object.defineProperty(globalThis, "codexPocketPush", { value: { serial: Promise.resolve() }, configurable: true });
}

const operations = globalThis.codexPocketPush as { serial: Promise<unknown> };

function withState<T>(action: (state: PushState) => T | Promise<T>) {
  const previous = operations.serial;
  const result = (async () => {
    try {
      await previous;
    } catch {
      // A failed operation must not block later subscriptions or notifications.
    }

    const state = (await readLocal<PushState | null>("push.json", null)) ?? {
      keys: webpush.generateVAPIDKeys(),
      subscriptions: [],
      notified: [],
    };
    const value = await action(state);
    await writeLocal("push.json", state);

    return value;
  })();
  operations.serial = result;

  return result;
}

export const pushPublicKey = () => withState((state) => state.keys.publicKey);

export async function saveSubscription(input: unknown) {
  const subscription = subscriptionSchema.parse(input);
  await withState((state) => {
    state.subscriptions = state.subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint);
    state.subscriptions.push(subscription);
  });
}

export function completionNotification(threadId: string, turn: Turn) {
  return {
    title: "Pocket",
    body:
      turn.status === "completed"
        ? "Codex finished. Your response is ready."
        : "Codex stopped. Open Pocket to see what happened.",
    tag: `${threadId}:${turn.id}`,
    url: "/",
  };
}

export async function notifyTurnComplete(threadId: string, turn: Turn) {
  const delivery = await withState((state) => {
    const receipt = `${threadId}:${turn.id}`;

    if (state.notified.includes(receipt) || state.subscriptions.length === 0) {
      return;
    }

    state.notified = [...state.notified, receipt].slice(-RECEIPT_LIMIT);

    return { keys: state.keys, subscriptions: state.subscriptions };
  });

  if (!delivery) {
    return;
  }

  const config = await readConfig();
  const subject = config?.allowedOrigins.find((origin) => origin.startsWith("https:"));

  if (!subject) {
    throw new Error("Push notifications require a configured HTTPS origin.");
  }

  const expired = new Set<string>();
  await Promise.all(
    delivery.subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(completionNotification(threadId, turn)), {
          vapidDetails: { ...delivery.keys, subject },
          TTL: PUSH_TTL_SECONDS,
          timeout: PUSH_TIMEOUT_MS,
          urgency: "normal",
        });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;

        if (status && EXPIRED_SUBSCRIPTION_STATUSES.has(status)) {
          expired.add(subscription.endpoint);
        } else {
          console.error(`Push delivery failed (${status ?? "network error"}).`);
        }
      }
    })
  );

  if (expired.size > 0) {
    await withState((state) => {
      state.subscriptions = state.subscriptions.filter((subscription) => !expired.has(subscription.endpoint));
    });
  }
}
