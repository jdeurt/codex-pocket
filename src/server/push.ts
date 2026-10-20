import { type Turn, string } from "../lib/protocol";
import { readLocal, writeLocal } from "./local-state";
import { log } from "./logging";
import { type NotificationPayload } from "../lib/notification-payload";
import { notificationPresence } from "./notification-presence";
import { readConfig } from "./config";
import webpush from "web-push";
import { z } from "zod";

const PUSH_TIMEOUT_MS = 10_000;
const PUSH_TTL_SECONDS = 3600;
const RECEIPT_LIMIT = 1000;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const MAX_ENDPOINT_LENGTH = 4096;
// RFC 8291 section 4: 4096 encrypted bytes allow 3993 bytes of JSON plaintext.
const MAX_PAYLOAD_BYTES = 3993;
const EXPIRED_SUBSCRIPTION_STATUSES = new Set([HTTP_NOT_FOUND, HTTP_GONE]);

export const subscriptionSchema = z.object({
  endpoint: z
    .url()
    .max(MAX_ENDPOINT_LENGTH)
    .refine((value) => new URL(value).protocol === "https:"),
  keys: z.object({
    p256dh: z.string().regex(/^[\w-]{87}=$|^[\w-]{87}$/),
    auth: z.string().regex(/^[\w-]{22}==$|^[\w-]{22}$/),
  }),
});

const pushStateSchema = z.object({
  keys: z.object({ publicKey: z.string(), privateKey: z.string() }),
  subscriptions: z.array(subscriptionSchema),
  notified: z.array(z.string()),
});

type PushState = z.infer<typeof pushStateSchema>;

declare global {
  var codexPocketPush: { serial: Promise<unknown> } | undefined;
}

const operations = globalThis.codexPocketPush ?? { serial: Promise.resolve() };

if (!globalThis.codexPocketPush) {
  Object.defineProperty(globalThis, "codexPocketPush", { value: operations, configurable: true });
}

function withState<T>(action: (state: PushState) => T | Promise<T>) {
  const previous = operations.serial;
  const result = (async () => {
    try {
      await previous;
    } catch {
      // A failed operation must not block later subscriptions or notifications.
    }

    const state = pushStateSchema.nullable().parse(await readLocal("push.json", null)) ?? {
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
  log().info({ provider: new URL(subscription.endpoint).origin }, "push.subscribed");
}

export function completionNotification(threadId: string, turn: Turn): NotificationPayload {
  const replies = turn.items.filter((item) => item.type === "agentMessage");
  const reply = replies.findLast((item) => item.phase === "final_answer") ?? replies.findLast((item) => !item.phase);

  return {
    title: "Pocket",
    body:
      string(reply?.text).trim() ||
      (turn.status === "completed"
        ? "Pocket finished. Your response is ready."
        : "Pocket stopped. Open Pocket to see what happened."),
    tag: `${threadId}:${turn.id}`,
    url: "/",
  };
}

export function completionPayload(threadId: string, turn: Turn) {
  const notification = completionNotification(threadId, turn);
  const payload = JSON.stringify(notification);

  if (Buffer.byteLength(payload) <= MAX_PAYLOAD_BYTES) {
    return payload;
  }

  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(notification.body),
    ({ segment }) => segment
  );

  let start = 0;
  let end = characters.length;

  // Measure serialized UTF-8, including escapes, and preserve whole Unicode characters.
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    const candidate = JSON.stringify({ ...notification, body: characters.slice(0, middle).join("") });

    if (Buffer.byteLength(candidate) <= MAX_PAYLOAD_BYTES) {
      start = middle;
    } else {
      end = middle - 1;
    }
  }

  return JSON.stringify({ ...notification, body: characters.slice(0, start).join("") });
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
      if (await notificationPresence.isForeground(subscription.endpoint)) {
        log().info({ threadId, turnId: turn.id }, "push.suppressed_foreground");

        return;
      }

      try {
        await webpush.sendNotification(subscription, completionPayload(threadId, turn), {
          vapidDetails: { ...delivery.keys, subject },
          TTL: PUSH_TTL_SECONDS,
          timeout: PUSH_TIMEOUT_MS,
          urgency: "normal",
        });
        log().info({ threadId, turnId: turn.id, provider: new URL(subscription.endpoint).origin }, "push.delivered");
      } catch (error) {
        const status =
          error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : undefined;

        if (status && EXPIRED_SUBSCRIPTION_STATUSES.has(status)) {
          expired.add(subscription.endpoint);
        } else {
          log().error({ status, threadId, turnId: turn.id }, "push.failed");
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
