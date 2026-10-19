import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { type Item, object, string } from "@/lib/protocol";
import { Message, MessageContent } from "@/components/ui/message";
import { ChatImage } from "./chat-image";
import { Markdown } from "./markdown";

function messageText(item: Item) {
  if (item.type === "agentMessage") {
    return string(item.text);
  }

  return Array.isArray(item.content)
    ? item.content
        .map((part) => string(object(part).text))
        .filter(Boolean)
        .join("\n")
    : "";
}

export function ChatMessage({ item }: { item: Item }) {
  return (
    <Message align={item.type === "userMessage" ? "end" : "start"}>
      <MessageContent>
        <Bubble
          data-message-id={string(item.clientId) || item.id}
          data-message-phase={string(item.phase) || undefined}
          data-delivery={item.type === "userMessage" ? "sent" : undefined}
          variant={item.type === "userMessage" ? "secondary" : "ghost"}
          align={item.type === "userMessage" ? "end" : "start"}
        >
          <BubbleContent>
            {Array.isArray(item.images) &&
              item.images.map((image) => (
                <ChatImage
                  key={string(object(image).source)}
                  source={string(object(image).source)}
                  alt={string(object(image).alt) || "Image from Pocket"}
                />
              ))}
            {item.type === "userMessage" ? (
              <p className="whitespace-pre-wrap">{messageText(item)}</p>
            ) : (
              <Markdown>{messageText(item)}</Markdown>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
