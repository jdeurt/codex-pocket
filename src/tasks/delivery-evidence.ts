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
