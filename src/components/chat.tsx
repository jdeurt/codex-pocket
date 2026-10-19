"use client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowUpIcon, TerminalIcon } from "lucide-react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { clientError, reportClient } from "@/lib/client-logging";
import { stageMessage, updateDelivery, useThread } from "@/hooks/use-thread";
import { useEffect, useRef, useState } from "react";
import { Conversation } from "./conversation";
import { NotificationPrompt } from "./notification-prompt";
import { connectionStatus } from "@/lib/connection-status";
import { modelDescription } from "@/lib/model-description";
import { post } from "@/lib/client-api";
import { useDraft } from "@/hooks/use-draft";

export function Chat() {
  const { state, connected: streamConnected } = useThread();
  const [draft, setDraft] = useDraft();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const messageId = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js").catch(console.error);
    }
  }, []);

  const connected = streamConnected && state.connection === "connected";
  const status = connectionStatus(state, streamConnected);

  async function send() {
    const text = draft.trim();

    if (!text || sending || !connected) {
      return;
    }

    const id = (messageId.current ??= crypto.randomUUID());
    reportClient("message.send", { id, text, activeTurnId: state.activeTurnId });
    setSending(true);
    setError("");
    stageMessage(id, text);
    setDraft("");

    try {
      const result = await post("/api/messages", { id, text });

      if (result.status === "unknown") {
        throw new Error("Delivery is uncertain. Check the conversation on your computer before sending again.");
      }

      updateDelivery(id, result.status === "sent" ? "sent" : "queued");
      reportClient("message.acknowledged", { id, status: result.status });
      messageId.current = null;
      textarea.current?.focus();
    } catch (error_) {
      reportClient("message.failed", { id, ...clientError(error_) }, "error");
      updateDelivery(id, "unknown");
      setDraft(text);
      setError(error_ instanceof Error ? error_.message : "Couldn't send. Try again when connected.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <div className="brand">
          <TerminalIcon aria-hidden="true" />
          <span>Pocket</span>
        </div>
        <div className="thread-heading">
          <h1>Pocket</h1>
          <p>
            <span aria-label="Model and reasoning effort">{modelDescription(state)}</span>
            <span aria-hidden="true"> · </span>
            <span role="status">{status}</span>
          </p>
        </div>
        <span className="header-balance" aria-hidden="true" />
      </header>
      <Conversation state={state} />
      <footer className="composer-wrap">
        <NotificationPrompt />
        {(error || state.error) && (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{error || state.error}</AlertDescription>
          </Alert>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel className="sr-only" htmlFor="message">
                Message Pocket
              </FieldLabel>
              <InputGroup className="composer">
                <InputGroupTextarea
                  ref={textarea}
                  id="message"
                  placeholder="Message Pocket…"
                  value={draft}
                  rows={1}
                  maxLength={32_000}
                  disabled={state.connection === "unconfigured" || sending}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    messageId.current = null;
                  }}
                  onKeyDown={(event) => {
                    if (!(
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      globalThis.matchMedia("(pointer: fine)").matches
                    )) {
                      return;
                    }

                    event.preventDefault();
                    void send();
                  }}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="submit"
                    variant="default"
                    size="icon-sm"
                    className="send-button"
                    aria-label="Send message"
                    disabled={!draft.trim() || sending || !connected}
                  >
                    <ArrowUpIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>
        </form>
      </footer>
    </main>
  );
}
