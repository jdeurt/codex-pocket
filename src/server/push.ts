import { t } from "try";
import { hasMessageText, messageText, turnMessages } from "../lib/turn-messages";
import { readLocal, writeLocal } from "./local-state";
import { type NotificationPayload } from "../lib/notification-payload";
import { type Turn } from "../lib/protocol";
import { log } from "./logging";
import { notificationPresence } from "./notification-presence";
import { pocketHref } from "../lib/pockets";
import { pocketStore } from "./pocket-store";
import { readConfig } from "./config";
import { visibleTurn } from "./visible-snapshot";
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

/**
Read and validate private push state, apply one queued operation, then atomically persist its result.
@param action - Push-state operation executed only after the previous queued write settles.
@returns The operation's result after its state has been persisted.
*/
async function pushTransaction<T>(action: (state: PushState) => T | Promise<T>) {
  const state = pushStateSchema.nullable().parse(await readLocal("push.json", null)) ?? {
    keys: webpush.generateVAPIDKeys(),
    subscriptions: [],
    notified: [],
  };
  const value = await action(state);

  await writeLocal("push.json", state);

  return value;
}

/**
Serialize push-state operations while allowing later work to recover from a failed write.
@param action - Concrete key, subscription or notification-receipt operation.
@returns The queued operation's result after durable state replacement.
*/
function withState<T>(action: (state: PushState) => T | Promise<T>) {
  const previous = operations.serial;

  async function commitQueuedState() {
    const completed = await t(previous);

    if (!completed.ok) {
      // A failed operation must not block later subscriptions or notifications.
    }

    return pushTransaction(action);
  }

  const result = commitQueuedState();

  operations.serial = result;

  return result;
}

/**
Read or initialize the stable public VAPID key through the private serialized state boundary.
@returns The persisted public subscription key.
*/
export function pushPublicKey() {
  return withState((state) => state.keys.publicKey);
}

/**
Validate a native browser subscription and replace only its matching endpoint in private state.
@param input - Untrusted browser subscription received by the same-origin endpoint.
*/
export async function saveSubscription(input: unknown) {
  const subscription = subscriptionSchema.parse(input);

  await withState((state) => {
    state.subscriptions = state.subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint);
    state.subscriptions.push(subscription);
  });
  log().info({ provider: new URL(subscription.endpoint).origin }, "push.subscribed");
}

/**
Select a rendered final assistant reply or visible image output for completion delivery.
@param threadId - Owning parent identity included only in the existing notification tag.
@param turn - Completed native turn whose final assistant output is selected.
@returns Shared completion payload, or undefined when the turn ended without a visible reply.
*/
export function completionNotification(threadId: string, turn: Turn): NotificationPayload | undefined {
  const messages = turnMessages(visibleTurn(turn), false).flatMap((entry) =>
    entry.kind === "message" ? [entry.item] : []
  );
  const replies = messages.filter((item) => item.type === "agentMessage");
  const reply = replies.findLast((item) => item.phase === "final_answer") ?? replies.findLast((item) => !item.phase);
  const hasImage = messages.some((item) => item.type === "imageOutput");

  if (!reply && !hasImage) {
    return;
  }

  return {
    title: "Pocket",
    body: reply && hasMessageText(reply) ? messageText(reply).trim() : "Pocket sent an image or attachment.",
    tag: `${threadId}:${turn.id}`,
    url: "/",
  };
}

/**
Bound serialized notification bytes while preserving complete native Unicode graphemes.
@param notification - Normalized completion notification whose full JSON exceeds the encrypted payload limit.
@returns JSON payload whose actual UTF-8 size fits the existing plaintext limit.
*/
function boundedPayload(notification: NotificationPayload) {
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

/**
Preserve full visible replies that fit and bound only oversized serialized completion notifications.
@param notification - Eligible visible completion selected before receipt claiming.
@returns Shared notification JSON within the existing encrypted-push byte budget.
*/
export function completionPayload(notification: NotificationPayload) {
  const payload = JSON.stringify(notification);

  return Buffer.byteLength(payload) <= MAX_PAYLOAD_BYTES ? payload : boundedPayload(notification);
}

/**
Deliver a claimed completion only to devices without a fresh foreground acknowledgement.
@param delivery - Validated subscription and key snapshot captured by the durable notification receipt.
@param subject - Configured HTTPS origin required for the native VAPID subject.
@param threadId - Owning parent identity retained in diagnostics and the existing notification tag.
@param turn - Native completed turn whose response is delivered.
@param payload - Serialized visible reply selected before claiming its receipt.
*/
async function sendCompletion(
  delivery: Pick<PushState, "keys" | "subscriptions">,
  subject: string,
  threadId: string,
  turn: Turn,
  payload: string
) {
  const expired = new Set<string>();

  await Promise.all(
    delivery.subscriptions.map(async (subscription) => {
      if (await notificationPresence.isForeground(subscription.endpoint)) {
        log().info({ threadId, turnId: turn.id }, "push.suppressed_foreground");

        return;
      }

      const sent = await t(() =>
        webpush.sendNotification(subscription, payload, {
          vapidDetails: { ...delivery.keys, subject },
          TTL: PUSH_TTL_SECONDS,
          timeout: PUSH_TIMEOUT_MS,
          urgency: "normal",
        })
      );

      if (sent.ok) {
        log().info({ threadId, turnId: turn.id, provider: new URL(subscription.endpoint).origin }, "push.delivered");
      } else {
        const error = sent.error;
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

/**
Require the configured HTTPS subject after claiming the receipt and before any native push attempt.
@param delivery - Validated key and subscription snapshot from the durable receipt operation.
@param threadId - Owning parent identity.
@param turn - Native completed turn whose response is being delivered.
@param payload - Serialized visible reply owned by this claimed receipt.
*/
async function deliverCompletion(
  delivery: Pick<PushState, "keys" | "subscriptions">,
  threadId: string,
  turn: Turn,
  payload: string
) {
  const config = await readConfig();
  const subject = config?.allowedOrigins.find((origin) => origin.startsWith("https:"));

  if (!subject) {
    throw new Error("Push notifications require a configured HTTPS origin.");
  }

  await sendCompletion(delivery, subject, threadId, turn, payload);
}

/**
Claim an eligible visible completion before its single foreground-aware delivery attempt.
@param threadId - Exact owning parent.
@param turn - Completed native turn.
@param notification - Canonical visible completion selected before receipt claiming.
*/
async function notifyVisible(threadId: string, turn: Turn, notification: NotificationPayload) {
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

  await deliverCompletion(delivery, threadId, turn, completionPayload(notification));
}

/** Resolve a completion link without changing another tab's selected Pocket.
@param threadId - Native owner of the completed turn.
@returns The saved conversation route, or the original home link.
*/
function notificationPocketUrl(threadId: string) {
  const pocket = pocketStore()
    .list()
    .find((entry) => entry.threadId === threadId);

  return pocket ? pocketHref(pocket.id) : "/";
}

/**
Require visible assistant output before claiming any durable push receipt.
@param threadId - Exact owning parent.
@param turn - Completed native turn.
*/
export async function notifyTurnComplete(threadId: string, turn: Turn) {
  const notification = completionNotification(threadId, turn);

  if (!notification) {
    return;
  }

  notification.url = notificationPocketUrl(threadId);
  await notifyVisible(threadId, turn, notification);
}
