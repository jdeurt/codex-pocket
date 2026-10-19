"use client";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ActivitySpinner } from "./activity-spinner";
import { FileAttachments } from "./file-attachments";
import { Prompt } from "./prompt";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Snapshot } from "@/lib/protocol";
import { TurnMessages } from "./turn-messages";
import { post } from "@/lib/client-api";
import { turnMessages } from "@/lib/turn-messages";
import { useConversationScroll } from "@/hooks/use-conversation-scroll";

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
  return connection === "unconfigured" ? (
    <MessageScrollerItem messageId="setup">
      <Empty className="chat-empty">
        <EmptyHeader>
          <EmptyTitle>Pocket, from here.</EmptyTitle>
          <EmptyDescription>Set CODEX_THREAD_ID in .env.local on your computer, then restart the app.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </MessageScrollerItem>
  ) : connection === "connecting" && empty ? (
    <MessageScrollerItem messageId="loading">
      <div aria-label="Loading conversation" className="flex flex-col gap-4 py-8">
        <Skeleton className="ml-auto h-12 w-2/3" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </MessageScrollerItem>
  ) : empty ? (
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

export function Conversation({
  state,
  readOnly = false,
  emptyMessage = "No visible messages saved yet.",
  activityControl,
  suspended = false,
}: {
  state: Snapshot;
  readOnly?: boolean;
  emptyMessage?: string;
  activityControl?: ReactNode;
  suspended?: boolean;
}) {
  const { viewportRef, autoScroll, onScroll } = useConversationScroll(suspended);
  const messages = state.turns.flatMap((turn) => {
    const entries = turnMessages(
      readOnly ? { ...turn, items: turn.items.filter((item) => item.type !== "pocketRestart") } : turn,
      turn.id === state.activeTurnId || turn.status === "inProgress"
    );

    return entries.length > 0 ? { id: turn.id, entries } : [];
  });
  const thinking = !!state.activeTurnId && state.requests.length === 0;
  const activity = state.activity ?? "Considering options";

  return (
    <MessageScrollerProvider autoScroll={autoScroll} defaultScrollPosition="end">
      <div className="min-h-0 flex-1">
        <MessageScroller>
          <MessageScrollerViewport ref={viewportRef} onScroll={onScroll}>
            <MessageScrollerContent className="transcript">
              <ConversationEmpty
                connection={state.connection}
                empty={messages.length === 0}
                readOnly={readOnly}
                emptyMessage={emptyMessage}
              />
              {messages.map((turn) => (
                <MessageScrollerItem messageId={turn.id} key={turn.id}>
                  <TurnMessages entries={turn.entries} />
                </MessageScrollerItem>
              ))}
              {state.queue.map((item) => (
                <MessageScrollerItem messageId={`queue-${item.id}`} key={item.id}>
                  <Message align="end">
                    <MessageContent>
                      <Bubble variant="secondary" align="end" data-message-id={item.id} data-delivery={item.status}>
                        <BubbleContent>
                          {item.attachments && <FileAttachments files={item.attachments} />}
                          <p className="whitespace-pre-wrap">{item.text}</p>
                        </BubbleContent>
                      </Bubble>
                      {item.status !== "sent" && (
                        <p className="delivery-status">
                          {item.status === "unknown"
                            ? "Delivery uncertain. Check on your computer."
                            : item.status === "sending"
                              ? "Sending…"
                              : "Queued"}
                        </p>
                      )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
              {state.requests.map((request) => (
                <MessageScrollerItem messageId={`request-${request.id}`} key={request.id}>
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
              {(thinking || activityControl) && (
                <MessageScrollerItem messageId="thinking" className="activity-item">
                  <div className="activity-row">
                    {thinking && (
                      <div
                        className="activity-indicator"
                        role="status"
                        aria-label="Pocket activity"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        <ActivitySpinner />
                        {activity && <span>{activity}</span>}
                      </div>
                    )}
                    {activityControl}
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton aria-label="Jump to latest message" size="icon-xl" className="rounded-full" />
        </MessageScroller>
      </div>
    </MessageScrollerProvider>
  );
}
