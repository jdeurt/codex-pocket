"use client";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Message, MessageContent } from "./ui/message";
import { Button } from "./ui/button";
import { type VoiceSegment } from "@/lib/voice-history";
import { realtimeCommand } from "@/lib/realtime-stream";
import { useState } from "react";

/** Display saved speech and allow an explicit, receipt-protected send after voice stops.
@param props - Durable speech and its known delivery state.
@returns A correctly attributed message with honest delivery and recovery controls.
*/
export function VoiceMessage({ segment }: { segment: VoiceSegment }) {
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState("");

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
        {segment.role === "user" && !segment.handoff && (
          <Button
            variant="ghost"
            disabled={isSending}
            onClick={() => {
              void (async () => {
                setSending(true);
                setError("");

                try {
                  await realtimeCommand({ action: "retry", id: segment.id });
                } catch (error_) {
                  setError(error_ instanceof Error ? error_.message : "Saved speech could not be sent.");
                } finally {
                  globalThis.dispatchEvent(new Event("pocket-voice-history"));
                  setSending(false);
                }
              })();
            }}
          >
            Send saved speech
          </Button>
        )}
        {error && <p role="alert">{error}</p>}
      </MessageContent>
    </Message>
  );
}
