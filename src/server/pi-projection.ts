import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type Item, type Turn, object, string } from "../lib/protocol";
import { nativeText } from "./harness/transcript";

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
    return [{ id: userId ?? id, type: "userMessage", content: message.content, source: "pi", original: message }];
  }

  if (message.role === "toolResult") {
    return [
      {
        id: message.toolCallId,
        type: "toolTrace",
        tool: message.toolName,
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
