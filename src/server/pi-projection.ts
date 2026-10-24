import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Turn } from "../lib/protocol";
import { piItems, piItemUpdate, receiptTurn } from "../state/pi-messages";

/**
Runtime identity owner for provider message objects and accepted receipt correlation.
*/
export class PiMessages {
  private identities = new WeakMap<object, string>();
  userIds: string[] = [];
  promptId?: string;

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
