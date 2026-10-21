"use client";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Message, MessageContent } from "@/components/ui/message";
import { type QueuedMessage, type Snapshot, string } from "@/lib/protocol";
import { messageText, turnMessages } from "@/lib/turn-messages";
import { ConversationActivity } from "./conversation-activity";
import { FileAttachments } from "./file-attachments";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Prompt } from "./prompt";
import { type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { VirtualizedTranscript } from "./virtualized-transcript";
import { post } from "@/lib/client-api";

/**
Select setup, loading or empty-state content for a conversation.
@param props - Connection state, emptiness, read-only mode and its empty-history message.
@returns The matching existing empty-state row, or null when messages are present.
*/
function ConversationEmpty({
  connection,
  empty,
  readOnly,
  emptyMessage,
}: {
  connection: Snapshot["connection"];
  empty: boolean;
  readOnly: boolean;
  emptyMessage: string;
}) {
  if (connection === "unconfigured") {
    return (
      <MessageScrollerItem messageId="setup">
        <Empty className="chat-empty">
          <EmptyHeader>
            <EmptyTitle>Pocket, from here.</EmptyTitle>
            <EmptyDescription>
              Set CODEX_THREAD_ID in .env.local on your computer, then restart the app.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </MessageScrollerItem>
    );
  }

  if (connection === "connecting" && empty) {
    return (
      <MessageScrollerItem messageId="loading">
        <div role="status" aria-label="Loading conversation" className="flex flex-col gap-4 py-8">
          <Skeleton className="ml-auto h-12 w-2/3" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </MessageScrollerItem>
    );
  }

  return empty ? (
    <MessageScrollerItem messageId="empty">
      <Empty className="chat-empty">
        <EmptyHeader>
          <EmptyTitle>{readOnly ? emptyMessage : "What are we working on?"}</EmptyTitle>
          {!readOnly && <EmptyDescription>Continue the conversation with Pocket on your computer.</EmptyDescription>}
        </EmptyHeader>
      </Empty>
    </MessageScrollerItem>
  ) : null;
}

/**
Describe the existing queue state while leaving sent-message omission to its owner.
@param status - Normalized delivery state from the shared queue schema.
@returns The existing uncertain, sending or queued label.
*/
function deliveryLabel(status: QueuedMessage["status"]) {
  if (status === "unknown") {
    return "Delivery uncertain. Check on your computer.";
  }

  return status === "sending" ? "Sending…" : "Queued";
}

/**
Compose canonical turn entries with standard transcript virtualization and current activity.
@param props - Normalized snapshot, read-only options, activity control and covered-parent suspension.
@returns The transcript, pending requests and existing conversation notices.
*/
export function Conversation({
  state,
  readOnly = false,
  emptyMessage = "No visible messages saved yet.",
  activityControl,
  showActivity = true,
  suspended = false,
  realtimeSegments = [],
}: {
  state: Snapshot;
  readOnly?: boolean;
  emptyMessage?: string;
  activityControl?: ReactNode;
  showActivity?: boolean;
  suspended?: boolean;
  realtimeSegments?: {
    id: number;
    role: "user" | "assistant";
    text: string;
    done: boolean;
    nativeSessionId?: string;
  }[];
}) {
  const projectedVoice = new Set(
    state.turns.flatMap((turn) =>
      turn.items.flatMap((item) => {
        const sessionId = string(item.realtimeSessionId);

        let role = "";

        if (item.type === "userMessage") {
          role = "user";
        } else if (item.type === "agentMessage") {
          role = "assistant";
        }

        return sessionId && role ? `${sessionId}\0${role}\0${messageText(item) || string(item.text)}` : [];
      })
    )
  );
  const messages = state.turns.flatMap((turn) => {
    const entries = turnMessages(
      readOnly ? { ...turn, items: turn.items.filter((item) => item.type !== "pocketRestart") } : turn,
      turn.id === state.activeTurnId || turn.status === "inProgress"
    );

    return entries.length > 0 ? { id: turn.id, entries } : [];
  });

  return (
    <>
      <VirtualizedTranscript
        key={state.threadId}
        storageKey={readOnly ? undefined : state.threadId}
        turns={messages}
        suspended={suspended}
        status={showActivity && <ConversationActivity state={state} control={activityControl} />}
      >
        <ConversationEmpty
          connection={state.connection}
          empty={messages.length === 0 && state.queue.length === 0 && realtimeSegments.length === 0}
          readOnly={readOnly}
          emptyMessage={emptyMessage}
        />
        {state.queue.map((item) => (
          <MessageScrollerItem messageId={`queue-${item.id}`} key={item.id}>
            <Message align="end">
              <MessageContent>
                <Bubble variant="secondary" align="end" data-message-id={item.id} data-delivery={item.status}>
                  <BubbleContent>
                    {item.attachments && <FileAttachments files={item.attachments} />}
                    {!!item.text.trim() && <p className="whitespace-pre-wrap">{item.text}</p>}
                  </BubbleContent>
                </Bubble>
                {item.status !== "sent" && <p className="delivery-status">{deliveryLabel(item.status)}</p>}
              </MessageContent>
            </Message>
          </MessageScrollerItem>
        ))}
        {realtimeSegments
          .filter(
            (segment) =>
              segment.text.trim() &&
              (!segment.nativeSessionId ||
                !projectedVoice.has(`${segment.nativeSessionId}\0${segment.role}\0${segment.text}`))
          )
          .map((segment) => (
            <MessageScrollerItem messageId={`voice-${String(segment.id)}`} key={`voice-${String(segment.id)}`}>
              <Message align={segment.role === "user" ? "end" : "start"}>
                <MessageContent>
                  <Bubble
                    variant={segment.role === "user" ? "secondary" : "default"}
                    align={segment.role === "user" ? "end" : "start"}
                  >
                    <BubbleContent>
                      <p className="whitespace-pre-wrap">{segment.text}</p>
                    </BubbleContent>
                  </Bubble>
                </MessageContent>
              </Message>
            </MessageScrollerItem>
          ))}
        {state.requests.map((request) => (
          <MessageScrollerItem messageId={`request-${String(request.id)}`} key={request.id}>
            <Prompt
              request={request}
              readOnly={readOnly}
              answer={
                readOnly
                  ? undefined
                  : async (id, result) => {
                      await post("/api/answers", { id, result });
                    }
              }
            />
          </MessageScrollerItem>
        ))}
      </VirtualizedTranscript>
    </>
  );
}
