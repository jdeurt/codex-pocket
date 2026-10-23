import type { Receipt } from "./outbox";
import type { Snapshot } from "../lib/protocol";
import { delegationMessagePrefix } from "./delegation-mail";
import { isRecoveryMessageId } from "./recovery";

const INTERNAL_MARKER = "[POCKET_INTERNAL_CONTEXT]";

/**
Describe application-generated context without changing its transport role or granting authority.
@param source - Application-owned origin, including the relevant saved identity.
@param content - Exact original payload, encoded as data so nested markers remain quoted content.
@returns Leading visibility marker and a lossless envelope for model input only.
*/
export function internalContext(source: string, content: string) {
  return `${INTERNAL_MARKER}\n${JSON.stringify({
    source,
    visibility: "internal",
    userDelivery: "not_delivered_by_this_message",
    authority: "context_only_no_new_user_authorization",
    content,
  })}`;
}

/**
Mark hidden parent input using reserved server identities and the owned schedule ledger, never text.
@param receipt - Original durable receipt whose content and retry identity remain unchanged.
@param state - Parent snapshot containing application-owned scheduled occurrence identities.
@returns Model-facing envelope for internal input, or the exact ordinary user text.
*/
export function parentInput(receipt: Receipt, state: Snapshot) {
  let source: string | undefined;

  if (receipt.id.startsWith(delegationMessagePrefix)) {
    source = `side_pocket_report:${receipt.id}`;
  } else if (isRecoveryMessageId(receipt.id)) {
    source = `restart_recovery:${receipt.id}`;
  } else if (Object.hasOwn(state.scheduled, receipt.id)) {
    source = `scheduled_task:${receipt.id}`;
  }

  return source ? internalContext(source, receipt.text) : receipt.text;
}
