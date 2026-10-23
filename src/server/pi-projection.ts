import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type Item, type Turn, type RpcEvent, object, string } from "../lib/protocol";
import { nativeText } from "./harness/transcript";
import { inputToolPreview, toolPreview } from "./tool-preview";

const MISSING_ITEM = -1;

/** Merge native Pi updates by identity before publishing the canonical transcript event.
@param turn - Current submission owning these items.
@param items - Native message or tool updates.
@param threadId - Owning parent identity.
@param emit - Existing Bridge event sink.
*/
export function publishPiItems(turn: Turn, items: Item[], threadId: string, emit: (event: RpcEvent) => void) {
  for (const item of items) {
    const index = turn.items.findIndex((existing) => existing.id === item.id);

    if (index === MISSING_ITEM) {
      turn.items.push(item);
    } else {
      turn.items[index] = item;
    }

    emit({ method: "item/completed", params: { threadId, turnId: turn.id, item } });
  }
}

/** Project Pi messages into Pocket's existing phone transcript without changing their source payload.
@param message - Native Pi message or final tool result.
@param turn - Owning Pocket submission lifecycle.
@param userId - Durable client receipt identity for an accepted user input.
@returns Ordered canonical items retaining the original Pi message and tool-call identities.
*/
export function piItems(message: AgentMessage, turn: Turn, userId?: string): Item[] {
  const raw = object(message);
  const id = `${turn.id}:${String(raw.timestamp)}:${string(raw.role)}`;

  if (message.role === "user") {
    return [
      {
        id: userId ?? id,
        clientId: userId,
        type: "userMessage",
        content: message.content,
        source: "pi",
        original: message,
      },
    ];
  }

  if (message.role === "toolResult") {
    const call = turn.items.find((item) => item.id === message.toolCallId);

    return [
      {
        id: message.toolCallId,
        type: "toolTrace",
        tool: message.toolName,
        toolLabels: call ? toolPreview(call) : [],
        status: message.isError ? "failed" : "completed",
        text: nativeText(message.content),
        source: "pi",
        original: message,
        images: message.content
          .filter((part) => part.type === "image")
          .map((part) => ({
            source: `data:${part.mimeType};base64,${part.data}`,
            alt: message.toolName,
          })),
      },
    ];
  }

  if (message.role !== "assistant") {
    return [];
  }

  return message.content.flatMap((part, index): Item[] => {
    switch (part.type) {
      case "text": {
        return [
          { id: `${id}:${String(index)}`, type: "agentMessage", text: part.text, source: "pi", original: message },
        ];
      }

      case "toolCall": {
        return [
          {
            id: part.id,
            type: "toolTrace",
            tool: part.name,
            toolLabels: inputToolPreview(part.name, object(part.arguments)),
            title: part.name,
            input: part.arguments,
            text: "",
            status: "running",
            source: "pi",
            original: part,
          },
        ];
      }

      default: {
        return [];
      }
    }
  });
}

/**
Reconcile accepted user receipts with Pi's later message events, including queued steering.
*/
export class PiMessages {
  private identities = new WeakMap<object, string>();
  userIds: string[] = [];
  promptId?: string;

  /** Project each native user message onto its original accepted receipt and turn.
  @param message - Native Pi event payload.
  @param active - Currently executing turn.
  @param turns - Durable projection containing earlier accepted inputs.
  @param threadId - Parent conversation identity.
  @param emit - Bridge event sink.
  */
  publish(message: AgentMessage, active: Turn, turns: Turn[], threadId: string, emit: (event: RpcEvent) => void) {
    let userId: string | undefined;

    if (message.role === "user") {
      userId = this.identities.get(message) ?? this.promptId ?? this.userIds.shift();
      this.promptId = undefined;

      if (userId) {
        this.identities.set(message, userId);
      }
    }

    const target = userId ? (turns.find((turn) => turn.items.some((item) => item.id === userId)) ?? active) : active;

    publishPiItems(target, piItems(message, target, userId), threadId, emit);
  }
}

/** Make accepted steering visible before Pi finishes its current tool.
@param turn - Original turn accepting the input.
@param receiptId - Durable submission identity.
@param text - Exact accepted text.
@param threadId - Parent conversation identity.
@param emit - Bridge event sink.
*/
export function publishAcceptedPiInput(
  turn: Turn,
  receiptId: string,
  text: string,
  threadId: string,
  emit: (event: RpcEvent) => void
) {
  publishPiItems(
    turn,
    [{ id: receiptId, clientId: receiptId, type: "userMessage", source: "pi", content: [{ type: "text", text }] }],
    threadId,
    emit
  );
}
