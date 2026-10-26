import type { Turn } from "../lib/protocol";
import { updateTasks } from "./repository";
import { recordEvent } from "./transitions";
import { reconcileRoutes } from "./reconciliation";
import type { Ledger } from "./model";

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

/** Recover confirmed user chat deliveries after restart using canonical records, never message markers.
@param parentId - Owning main Pocket.
@param turns - Persisted application-owned Pi history.
*/
export function reconcileTaskDeliveries(parentId: string, turns: Turn[]) {
  updateTasks(
    parentId,
    "Reconcile canonical chat delivery evidence after restart",
    persistedChatDeliveries.bind(undefined, turns)
  );
}
