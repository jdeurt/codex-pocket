"use client";
import "./focused-composer.css";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowUpIcon, PaperclipIcon, TerminalIcon } from "lucide-react";
import { type DraftAttachment, useAttachments } from "@/hooks/use-attachments";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { clientError, reportClient } from "@/lib/client-logging";
import { stageMessage, updateDelivery, useThread } from "@/hooks/use-thread";
import { useEffect, useRef, useState } from "react";
import { AgentBrowser } from "./agent-browser";
import { ComposerAttachments } from "./composer-attachments";
import { Conversation } from "./conversation";
import { NotificationPrompt } from "./notification-prompt";
import { connectionStatus } from "@/lib/connection-status";
import { modelDescription } from "@/lib/model-description";
import { post } from "@/lib/client-api";
import { useComposerViewport } from "@/hooks/use-composer-viewport";
import { useDraft } from "@/hooks/use-draft";

function hasMessage(text: string, files: DraftAttachment[]) {
  return (!!text.trim() || files.length > 0) && files.every((entry) => !!entry.uploaded);
}

export function Chat() {
  const { state, connected: streamConnected } = useThread();
  const [draft, setDraft] = useDraft();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [agentsOpen, setAgentsOpen] = useState(false);
  const messageId = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useComposerViewport(textarea);
  const filePicker = useRef<HTMLInputElement>(null);
  const recoveredMessage = useRef<string | undefined>(undefined);
  const attachments = useAttachments(state.threadId);

  useEffect(() => {
    if (!attachments.pending || recoveredMessage.current === attachments.pending.id) {
      return;
    }

    recoveredMessage.current = attachments.pending.id;

    if (!draft && !sending) {
      setDraft(attachments.pending.text);
    }
  }, [attachments.pending, draft, sending, setDraft]);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js").catch(console.error);
    }
  }, []);

  const connected = streamConnected && state.connection === "connected";
  const status = connectionStatus(state, streamConnected);

  async function send() {
    const text = draft.trim();
    const files = attachments.files.flatMap((entry) => (entry.uploaded ? [entry.uploaded] : []));

    if (!hasMessage(text, attachments.files) || sending || !connected || !attachments.ready) {
      return;
    }

    const id = (messageId.current ??=
      attachments.pending?.text === text ? attachments.pending.id : crypto.randomUUID());
    reportClient("message.send", { id, text, activeTurnId: state.activeTurnId });
    setSending(true);
    setError("");

    try {
      await attachments.rememberSend(id, text);

      stageMessage(id, text, files);
      setDraft("");
      const result = await post("/api/messages", { id, text, attachments: files.map((file) => file.id) });

      if (result.status === "unknown") {
        throw new Error("Delivery is uncertain. Check the conversation on your computer before sending again.");
      }

      updateDelivery(id, result.status === "sent" ? "sent" : "queued");
      reportClient("message.acknowledged", { id, status: result.status });

      await attachments.clear();

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
      <Conversation
        state={state}
        suspended={agentsOpen}
        activityControl={<AgentBrowser onOpenChange={setAgentsOpen} />}
      />
      <footer className="composer-wrap">
        <NotificationPrompt />
        {(error || attachments.error || state.error) && (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{error || attachments.error || state.error}</AlertDescription>
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
              <ComposerAttachments
                files={attachments.files}
                disabled={sending}
                remove={async (id) => {
                  messageId.current = null;
                  await attachments.remove(id);
                }}
                retry={attachments.retry}
              />
              <input
                ref={filePicker}
                type="file"
                multiple
                hidden
                aria-label="Choose attachments"
                disabled={sending || !attachments.ready || state.connection === "unconfigured"}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  messageId.current = null;
                  void attachments.add(files);
                }}
              />
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
                    type="button"
                    size="icon-sm"
                    className="min-h-11 min-w-11"
                    aria-label="Attach images or files"
                    title="Attach images or files"
                    disabled={sending || !attachments.ready || state.connection === "unconfigured"}
                    onClick={() => filePicker.current?.click()}
                  >
                    <PaperclipIcon aria-hidden="true" />
                  </InputGroupButton>
                  <InputGroupButton
                    type="submit"
                    variant="default"
                    size="icon-sm"
                    className="send-button"
                    aria-label="Send message"
                    disabled={!hasMessage(draft, attachments.files) || sending || !connected || !attachments.ready}
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
