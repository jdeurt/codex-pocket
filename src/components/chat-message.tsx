import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { type Item, object, string } from "@/lib/protocol";
import { Message, MessageContent } from "@/components/ui/message";
import { hasMessageText, messageText } from "@/lib/turn-messages";
import { AttachmentGroup } from "@/components/ui/attachment";
import { ChatImage } from "./chat-image";
import type { FileAttachment } from "@/lib/attachments";
import { FileAttachments } from "./file-attachments";
import { Markdown } from "./markdown";
import { SystemEvent } from "./system-event";
import { ToolMessage } from "./tool-message";

function uploadedFiles(item: Item) {
  return Array.isArray(item.attachments) ? (item.attachments as FileAttachment[]) : [];
}

export function ChatMessage({ item }: { item: Item }) {
  if (item.type === "pocketRestart") {
    return <SystemEvent />;
  }

  if (item.type === "toolTrace") {
    return <ToolMessage item={item} />;
  }

  const files = uploadedFiles(item);
  const text = messageText(item);

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
            <FileAttachments files={files} />
            {files.length === 0 && Array.isArray(item.images) && item.images.length > 0 && (
              <AttachmentGroup layout="wrap" className="chat-images">
                {item.images.map((image) => (
                  <ChatImage
                    key={string(object(image).source)}
                    source={string(object(image).source)}
                    alt={string(object(image).alt) || "Image from Pocket"}
                  />
                ))}
              </AttachmentGroup>
            )}
            {hasMessageText(item) &&
              (item.type === "userMessage" ? (
                <p className="whitespace-pre-wrap">{text}</p>
              ) : (
                <Markdown
                  imageBase={string(item.imageBase) || undefined}
                  allowCopyActions={item.type === "agentMessage"}
                >
                  {text}
                </Markdown>
              ))}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
