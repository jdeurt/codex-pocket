import { recordTaskDelivery } from "../tasks/delivery-evidence";
import { Type } from "@earendil-works/pi-ai";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type PiHistory } from "../runtime/pi-history";
import { piChatMessage } from "../state/pi-chat";

const parameters = Type.Object({ message: Type.String({ minLength: 1 }) });

/**
Publish explicit main-agent reports through the existing canonical history and persistence owner.
*/
export class PiChat {
  /** Bind this main agent's tool to its existing history owner.
  @param threadId - Owning main Pocket.
  @param history - Canonical Pi history, never a Side Pocket mailbox.
  */
  constructor(
    private threadId: string,
    private history: PiHistory
  ) {}

  /** Persist the chosen chat message before acknowledging delivery to the model.
  @param callId - Native invocation identity retained for retries.
  @param input - Complete Markdown message.
  @param signal - Native cancellation boundary.
  @returns Confirmed delivery identity without another inference or voice round trip.
  */
  private async execute(callId: string, input: { message: string }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const turn = this.history.active;

    if (!turn) {
      throw new Error("Sending to chat requires an active main Pocket turn.");
    }

    const update = piChatMessage(turn, this.threadId, callId, input.message);

    if (update) {
      this.history.publish(update);
    }

    await this.history.persist();
    recordTaskDelivery(this.threadId, callId);
    const delivered = { id: `pi-chat:${callId}`, status: "delivered", message: input.message };

    return { content: [{ type: "text" as const, text: JSON.stringify(delivered) }], details: delivered };
  }

  /** Expose a parent-only tool that delivers reports and links directly to the shared chat.
  @returns Native Pi tool bound to canonical publication.
  */
  tool(): ToolDefinition<typeof parameters> {
    return {
      name: "pocket_send_to_chat",
      label: "Send to chat",
      description:
        "Send a complete report, document, or Markdown links directly to this Pocket's chat, including during voice. " +
        "Use this when the user needs readable content instead of relying on spoken delivery. " +
        "Only main Pocket authored content is delivered. Do not repeat the same message in your final reply. " +
        "Tell the voice interface briefly what was delivered after this tool confirms success.",
      parameters,
      execute: this.execute.bind(this),
    };
  }
}
