import { z } from "zod";

const RECEIPT_LIMIT = 1000;

/** Validate the transport protocol of an already validated URL.
@param value - Absolute endpoint URL.
@returns Whether the endpoint uses HTTPS.
*/
function isHttps(value: string) {
  return new URL(value).protocol === "https:";
}

const MAX_ENDPOINT_LENGTH = 4096;
export const subscriptionSchema = z.object({
  endpoint: z.url().max(MAX_ENDPOINT_LENGTH).refine(isHttps),
  keys: z.object({
    p256dh: z.string().regex(/^[\w-]{87}=$|^[\w-]{87}$/),
    auth: z.string().regex(/^[\w-]{22}==$|^[\w-]{22}$/),
  }),
});

export const pushStateSchema = z.object({
  keys: z.object({ publicKey: z.string(), privateKey: z.string() }),
  subscriptions: z.array(subscriptionSchema),
  notified: z.array(z.string()),
});

export type PushState = z.infer<typeof pushStateSchema>;

export type Subscription = z.infer<typeof subscriptionSchema>;
export interface PushChange<T> {
  state: PushState;
  value: T;
}

/** Read the public key without changing private state.
@param state - Validated durable state.
@returns Unchanged state and public subscription key.
*/
export function publicKey(state: PushState): PushChange<string> {
  return { state, value: state.keys.publicKey };
}

/** Replace only the matching browser endpoint.
@param subscription - Validated native subscription.
@param state - Current durable state.
@returns Independent next state.
*/
export function subscribed(subscription: Subscription, state: PushState): PushChange<undefined> {
  const subscriptions: Subscription[] = [];

  for (const entry of state.subscriptions) {
    if (entry.endpoint !== subscription.endpoint) {
      subscriptions.push(entry);
    }
  }

  return { state: { ...state, subscriptions: [...subscriptions, subscription] }, value: undefined };
}

/** Remove endpoints the native service has explicitly expired.
@param expired - Native expired endpoint identities.
@param state - Current durable state.
@returns State retaining all other subscriptions.
*/
export function withoutExpired(expired: Set<string>, state: PushState): PushChange<undefined> {
  const subscriptions: Subscription[] = [];

  for (const entry of state.subscriptions) {
    if (!expired.has(entry.endpoint)) {
      subscriptions.push(entry);
    }
  }

  return { state: { ...state, subscriptions }, value: undefined };
}

/** Claim one visible completion before native delivery.
@param receipt - Stable parent and turn identity.
@param state - Current durable state.
@returns Updated receipts and the claimed key/subscription snapshot.
*/
export function claimedCompletion(
  receipt: string,
  state: PushState
): PushChange<Pick<PushState, "keys" | "subscriptions"> | undefined> {
  if (state.notified.includes(receipt) || state.subscriptions.length === 0) {
    return { state, value: undefined };
  }

  return {
    state: { ...state, notified: [...state.notified, receipt].slice(-RECEIPT_LIMIT) },
    value: { keys: state.keys, subscriptions: state.subscriptions },
  };
}
