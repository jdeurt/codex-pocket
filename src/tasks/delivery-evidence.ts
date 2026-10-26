import { string, type Turn, type Item, object } from "../lib/protocol";
import { updateTasks } from "./repository";
import { recordEvent } from "./transitions";
import { reconcileRoutes } from "./reconciliation";
import type { Ledger } from "./model";
import { readTaskSources, type TaskSource } from "./sources";
import { visibleTurn } from "../state/visible-snapshot";

/** Record actual canonical chat persistence, independently of model completion.
@param callId - Exact native chat-delivery invocation.
@param state - Current ledger.
@returns Explicit delivery evidence connected through call ownership.
*/
function deliveredChat(callId: string, state: Ledger) {
  return reconcileRoutes(
    recordEvent(state, {
      id: `delivery:${callId}`,
      parentId: state.parentId,
      origin: "assistant",
      text: "",
      inReplyTo: `call:${callId}`,
      contentRefs: [`pi-chat:${callId}`],
      visibility: "user",
      delivery: "delivered",
    })
  );
}

/** Persist delivery evidence only after canonical chat storage acknowledges success.
@param parentId - Owning main Pocket.
@param callId - Original native tool invocation identity.
*/
export function recordTaskDelivery(parentId: string, callId: string) {
  updateTasks(parentId, "Record confirmed user chat delivery", deliveredChat.bind(undefined, callId));
}

/** Reconcile delivery identities from canonical chat records acknowledged before an interrupted ledger write.
@param turns - Application-owned persisted Pi projection.
@param state - Parent ledger.
@returns Delivery evidence without guessing task membership from chronological proximity.
*/
function persistedChatDeliveries(turns: Turn[], state: Ledger) {
  let next = state;

  for (const turn of turns) {
    for (const item of turn.items) {
      if (
        item.type !== "agentMessage" ||
        item.source !== "pi" ||
        item.delivery !== "chat" ||
        !item.id.startsWith("pi-chat:")
      ) {
        continue;
      }

      next = deliveredChat(item.id.slice("pi-chat:".length), next);
    }
  }

  return next;
}

/** Correlate a persisted visible item with exactly one native original in the same application-owned turn.
@param state - Parent ledger.
@param sources - Validated immutable originals.
@param turn - Canonical persisted turn.
@param item - Actually visible Pi-authored message.
@returns Exact native event identity, or undefined when correlation is missing or ambiguous.
*/
function visibleOrigin(state: Ledger, sources: TaskSource[], turn: Turn, item: Item) {
  if (item.original === undefined) {
    return;
  }

  const matches = new Set<string>();
  const original = JSON.stringify(item.original);

  for (const event of state.events) {
    if (event.origin !== "assistant" || event.turnId !== turn.id || !event.nativeEntryId) {
      continue;
    }

    for (const source of sources) {
      if (
        source.entry.id === event.nativeEntryId &&
        JSON.stringify(object(source.entry.original).message) === original
      ) {
        matches.add(event.id);
      }
    }
  }

  return matches.size === 1 ? [...matches][0] : undefined;
}

/** Record canonical chat availability through the same visibility rules used by the phone.
@param turns - Persisted canonical turns, never an uncommitted model output.
@param sources - Validated exact native originals.
@param state - Current checkpoint.
@returns Actual public-delivery evidence; private voice backend output remains excluded.
*/
function persistedVisibleDeliveries(turns: Turn[], sources: TaskSource[], state: Ledger) {
  let next = persistedChatDeliveries(turns, state);

  for (const turn of turns) {
    const visible = visibleTurn({}, turn);

    for (const item of visible.items) {
      if (
        item.type !== "agentMessage" ||
        item.source !== "pi" ||
        item.delivery === "chat" ||
        !string(item.text).trim()
      ) {
        continue;
      }

      const origin = visibleOrigin(next, sources, turn, item);

      if (!origin) {
        continue;
      }

      next = recordEvent(next, {
        id: `delivery:pi-item:${item.id}`,
        parentId: state.parentId,
        origin: "assistant",
        inReplyTo: origin,
        text: string(item.text),
        contentRefs: [`pi-projection:${turn.id}:${item.id}`],
        visibility: "user",
        delivery: "delivered",
      });
    }
  }

  return reconcileRoutes(next);
}

/** Recover confirmed user chat deliveries after restart using canonical records, never message markers.
@param parentId - Owning main Pocket.
@param turns - Persisted application-owned Pi history.
*/
export async function reconcileTaskDeliveries(parentId: string, turns: Turn[]) {
  const sources = await readTaskSources(parentId);

  updateTasks(
    parentId,
    "Reconcile canonical chat delivery evidence after restart",
    persistedVisibleDeliveries.bind(undefined, turns, sources)
  );
}
