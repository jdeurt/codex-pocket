import { t } from "try";
import { SerialQueue } from "../runtime/serial-queue";
import { readLocal, writeLocal } from "./local-state";
import {
  type PushState,
  type PushChange,
  type Subscription,
  pushStateSchema,
  subscriptionSchema,
  publicKey,
  subscribed,
  withoutExpired,
  claimedCompletion,
} from "../state/push";
import { completionNotification, completionPayload } from "../state/completion-notification";
import type { NotificationPayload } from "../lib/notification-payload";
import type { Turn } from "../lib/protocol";
import { log } from "./logging";
import { notificationPresence } from "./notification-presence";
import { pocketHref } from "../lib/pockets";
import { pocketStore } from "./pocket-store";
import { readConfig } from "./config";
import webpush from "web-push";

export { subscriptionSchema } from "../state/push";
export { completionNotification, completionPayload } from "../state/completion-notification";

const PUSH_TIMEOUT_MS = 10_000;
const PUSH_TTL_SECONDS = 3600;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const EXPIRED_SUBSCRIPTION_STATUSES = new Set([HTTP_NOT_FOUND, HTTP_GONE]);

declare global {
  var codexPocketPush: SerialQueue | undefined;
}

const operations = globalThis.codexPocketPush ?? new SerialQueue();

if (!globalThis.codexPocketPush) {
  Object.defineProperty(globalThis, "codexPocketPush", { value: operations, configurable: true });
}

/** Read, apply a pure transition, then durably replace private push state.
@param action - Pure state transition.
@returns Transition result only after persistence succeeds.
*/
async function pushTransaction<T>(action: (state: PushState) => PushChange<T>) {
  const state = pushStateSchema.nullable().parse(await readLocal("push.json", null)) ?? {
    keys: webpush.generateVAPIDKeys(),
    subscriptions: [],
    notified: [],
  };
  const change = action(state);

  await writeLocal("push.json", change.state);

  return change.value;
}

/** Serialize persistence while keeping completion separate from operation failure.
@param action - Pure push state transition.
@returns Durable operation result or its original failure.
*/
function withState<T>(action: (state: PushState) => PushChange<T>) {
  return operations.run(pushTransaction<T>, action);
}

/** Read or initialize the durable public subscription key.
@returns Persisted public key.
*/
export function pushPublicKey() {
  return withState(publicKey);
}

/** Validate and durably replace a browser subscription.
@param input - Untrusted browser subscription.
*/
export async function saveSubscription(input: unknown) {
  const subscription = subscriptionSchema.parse(input);

  await withState(subscribed.bind(undefined, subscription));
  log().info({ provider: new URL(subscription.endpoint).origin }, "push.subscribed");
}

/** Deliver to one background device and retain native failure diagnostics.
@param delivery - Claimed durable key/subscription snapshot.
@param subject - Verified HTTPS origin.
@param tag - Parent and turn identity for diagnostics.
@param payload - Bounded serialized notification.
@param subscription - Native device endpoint.
@returns Expired endpoint only when the provider explicitly rejects its lifetime.
*/
async function sendDevice(
  delivery: Pick<PushState, "keys" | "subscriptions">,
  subject: string,
  tag: string,
  payload: string,
  subscription: Subscription
) {
  if (await notificationPresence.isForeground(subscription.endpoint)) {
    log().info({ tag }, "push.suppressed_foreground");

    return;
  }

  const sent = await t(webpush.sendNotification.bind(webpush), subscription, payload, {
    vapidDetails: { ...delivery.keys, subject },
    TTL: PUSH_TTL_SECONDS,
    timeout: PUSH_TIMEOUT_MS,
    urgency: "normal",
  });

  if (sent.ok) {
    log().info({ tag, provider: new URL(subscription.endpoint).origin }, "push.delivered");

    return;
  }

  const error = sent.error;
  const status =
    error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;

  if (status && EXPIRED_SUBSCRIPTION_STATUSES.has(status)) {
    return subscription.endpoint;
  }

  log().error({ err: error, status, tag }, "push.failed");
}

/** Deliver one claimed completion and remove provider-expired devices.
@param delivery - Claimed durable snapshot.
@param notification - Visible completion with its correct Pocket route.
*/
async function deliverCompletion(
  delivery: Pick<PushState, "keys" | "subscriptions">,
  notification: NotificationPayload
) {
  const config = await readConfig();

  let subject: string | undefined;

  const origins = config?.allowedOrigins ?? [];

  for (const origin of origins) {
    if (origin.startsWith("https:")) {
      subject = origin;
      break;
    }
  }

  if (!subject) {
    throw new Error("Push notifications require a configured HTTPS origin.");
  }

  const payload = completionPayload(notification);
  const pending = Array.from(
    delivery.subscriptions,
    sendDevice.bind(undefined, delivery, subject, notification.tag, payload)
  );
  const results = await Promise.all(pending);
  const expired = new Set<string>();

  for (const result of results) {
    if (result) {
      expired.add(result);
    }
  }

  if (expired.size > 0) {
    await withState(withoutExpired.bind(undefined, expired));
  }
}

/** Resolve the saved route for a completed parent.
@param threadId - Native owner identity.
@returns Saved Pocket route or the original home link.
*/
function notificationPocketUrl(threadId: string) {
  for (const entry of pocketStore().list()) {
    if (entry.threadId === threadId) {
      return pocketHref(entry.id);
    }
  }

  return "/";
}

/** Claim only visible completions before native delivery.
@param threadId - Exact owning parent.
@param turn - Completed native turn.
*/
export async function notifyTurnComplete(threadId: string, turn: Turn) {
  const notification = completionNotification(threadId, turn);

  if (!notification) {
    return;
  }

  const delivery = await withState(claimedCompletion.bind(undefined, `${threadId}:${turn.id}`));

  if (delivery) {
    await deliverCompletion(delivery, { ...notification, url: notificationPocketUrl(threadId) });
  }
}
