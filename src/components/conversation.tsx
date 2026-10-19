"use client";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { type Item, type Snapshot, object, string } from "@/lib/protocol";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Markdown } from "./markdown";
import { Prompt } from "./prompt";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { post } from "@/lib/client-api";

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

export function Conversation({ state }: { state: Snapshot }) {
  const messages = state.turns
    .flatMap((turn) => turn.items)
    .filter((item) => ["userMessage", "agentMessage"].includes(item.type));
  const thinking = !!state.activeTurnId && state.requests.length === 0;

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <div className="min-h-0 flex-1">
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="transcript">
              {state.connection === "unconfigured" ? (
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
              ) : state.connection === "connecting" && messages.length === 0 ? (
                <MessageScrollerItem messageId="loading">
                  <div aria-label="Loading conversation" className="flex flex-col gap-4 py-8">
                    <Skeleton className="ml-auto h-12 w-2/3" />
                    <Skeleton className="h-4 w-4/5" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                </MessageScrollerItem>
              ) : messages.length === 0 ? (
                <MessageScrollerItem messageId="empty">
                  <Empty className="chat-empty">
                    <EmptyHeader>
                      <EmptyTitle>What are we working on?</EmptyTitle>
                      <EmptyDescription>Continue the conversation with Pocket on your computer.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </MessageScrollerItem>
              ) : null}
              {messages.map((item) => (
                <MessageScrollerItem messageId={item.id} key={item.id}>
                  <Message align={item.type === "userMessage" ? "end" : "start"}>
                    <MessageContent>
                      <Bubble
                        data-message-id={string(item.clientId) || item.id}
                        data-delivery={item.type === "userMessage" ? "sent" : undefined}
                        variant={item.type === "userMessage" ? "secondary" : "ghost"}
                        align={item.type === "userMessage" ? "end" : "start"}
                      >
                        <BubbleContent>
                          {item.type === "userMessage" ? (
                            <p className="whitespace-pre-wrap">{messageText(item)}</p>
                          ) : (
                            <Markdown>{messageText(item)}</Markdown>
                          )}
                        </BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
              {state.queue.map((item) => (
                <MessageScrollerItem messageId={`queue-${item.id}`} key={item.id}>
                  <Message align="end">
                    <MessageContent>
                      <Bubble variant="secondary" align="end" data-message-id={item.id} data-delivery={item.status}>
                        <BubbleContent>
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
                    answer={async (id, result) => {
                      await post("/api/answers", { id, result });
                    }}
                  />
                </MessageScrollerItem>
              ))}
              {thinking && (
                <MessageScrollerItem messageId="thinking">
                  <Spinner className="activity-spinner" aria-label="Thinking" />
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
