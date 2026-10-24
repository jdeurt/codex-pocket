"use client";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Message, MessageContent } from "./ui/message";
import { type VoiceSegment } from "@/lib/voice-history";

/** Display native realtime reply text and retain historical voice messages.
@param props - Text supplied by the provider alongside its spoken response.
@returns A transcript row, without treating speech as an unsent main-agent command.
*/
export function VoiceMessage({ segment }: { segment: VoiceSegment }) {
  return (
    <Message align={segment.role === "user" ? "end" : "start"}>
      <MessageContent>
        <Bubble
          variant={segment.role === "user" ? "secondary" : "ghost"}
          align={segment.role === "user" ? "end" : "start"}
          data-message-id={segment.id}
        >
          <BubbleContent>
            <p className="whitespace-pre-wrap">{segment.text}</p>
          </BubbleContent>
        </Bubble>
        {segment.handoff === "unknown" && (
          <p className="delivery-status" role="status">
            Handoff delivery uncertain. Check Pocket before retrying.
          </p>
        )}
      </MessageContent>
    </Message>
  );
}
