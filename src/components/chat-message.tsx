import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { type Item, string } from "@/lib/protocol";
import { Message, MessageContent } from "@/components/ui/message";
import { hasMessageText, messageText } from "@/lib/turn-messages";
import { AttachmentGroup } from "@/components/ui/attachment";
import { ChatImage } from "./chat-image";
import { DelegateReport } from "./delegate-report";
import { FileAttachments } from "./file-attachments";
import { Markdown } from "./markdown";
import { SystemEvent } from "./system-event";
import { ToolMessage } from "./tool-message";
import { VoiceMessage } from "./voice-message";
import { voiceSegmentSchema } from "@/lib/voice-history";

/**
Keep durable file metadata ahead of native image-only attachment fallback.
@param props - Normalized message item with optional files or image sources.
@returns Static file rows or image attachments without duplicate upload previews.
*/
function MessageAttachments({ item }: { item: Item }) {
  const files = item.attachments ?? [];

  return (
    <>
      <FileAttachments files={files} />
      {files.length === 0 && item.images && item.images.length > 0 && (
        <AttachmentGroup layout="wrap" className="chat-images">
          {item.images.map((image) => (
            <ChatImage
              key={image.source}
              source={image.source}
              alt={image.alt?.length ? image.alt : "Image from Pocket"}
            />
          ))}
        </AttachmentGroup>
      )}
    </>
  );
}

/**
Render ordinary message text and attachments through the shared bubble and Markdown components.
@param props - Normalized transcript item from the shared protocol boundary.
@returns The matching shared message presentation.
*/
function MessageBubble({ item }: { item: Item }) {
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
            <MessageAttachments item={item} />
            {hasMessageText(item) &&
              (item.type === "userMessage" ? (
                <p className="whitespace-pre-wrap">{text}</p>
              ) : (
                <Markdown
                  revealFrom={typeof item.revealFrom === "number" ? item.revealFrom : undefined}
                  revealId={string(item.revealId) || undefined}
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

/**
Dispatch restart notes, normalized tool traces and ordinary conversation messages.
@param props - Normalized transcript item from the shared protocol boundary.
@returns The matching shared message presentation.
*/
export function ChatMessage({ item }: { item: Item }) {
  if (item.type === "voiceMessage") {
    const segment = voiceSegmentSchema.parse(item.voice);

    return <VoiceMessage segment={segment} />;
  }

  if (item.type === "delegateReport" && item.delegateReport) {
    return <DelegateReport report={item.delegateReport} />;
  }

  if (item.type === "pocketRestart") {
    return <SystemEvent />;
  }

  return item.type === "toolTrace" ? <ToolMessage item={item} /> : <MessageBubble item={item} />;
}
