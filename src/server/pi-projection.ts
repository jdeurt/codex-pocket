import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { t } from "try";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Turn } from "../lib/protocol";
import { piItems, piItemUpdate, receiptTurn } from "../state/pi-messages";

const MISSING_RECEIPT = -1;

/**
Runtime identity owner for provider message objects and accepted receipt correlation.
*/
export class PiMessages {
  private identities = new WeakMap<object, string>();
  private userIds: string[] = [];
  promptId?: string;

  /** Read the receipt already correlated with a native message object.
  @param message - Original provider object observed by projection.
  @returns Accepted receipt identity when established.
  */
  receiptIdentity(message: AgentMessage) {
    return this.identities.get(message);
  }

  /** Reserve native correlation before sending and release receipts rejected by Pi.
  @param session - Native steering boundary.
  @param id - Durable correction receipt.
  @param text - Original correction.
  @param images - Native image attachments, if present.
  */
  async steer(
    session: Pick<AgentSession, "steer">,
    id: string,
    text: string,
    images?: Parameters<AgentSession["steer"]>[1]
  ) {
    this.userIds.push(id);
    const sent = await t(session.steer.bind(session), text, images);

    if (sent.ok && sent.value === "queued") {
      return;
    }

    const index = this.userIds.indexOf(id);

    if (index !== MISSING_RECEIPT) {
      this.userIds.splice(index, 1);
    }

    if (!sent.ok) {
      throw sent.error;
    }

    throw new Error("Pi handled this input without queueing a correction. Inspect the active work before continuing.");
  }

  /** Correlate one provider object before projecting its immutable turn update.
  @param message - Original native message object.
  @param active - Active canonical turn.
  @param turns - Current canonical history.
  @param threadId - Owning parent identity.
  @returns Updated turn and canonical publication events.
  */
  project(message: AgentMessage, active: Turn, turns: Turn[], threadId: string) {
    let userId: string | undefined;

    if (message.role === "user") {
      userId = this.identities.get(message) ?? this.promptId ?? this.userIds[0];

      if (!this.identities.has(message) && this.promptId === undefined) {
        this.userIds = this.userIds.slice(1);
      }

      this.promptId = undefined;

      if (userId) {
        this.identities.set(message, userId);
      }
    }

    const target = receiptTurn(turns, userId, active);

    return piItemUpdate(target, piItems(message, target, userId), threadId);
  }
}
