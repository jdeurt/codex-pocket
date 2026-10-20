"use client";
import "./focused-composer.css";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowUpIcon, PaperclipIcon } from "lucide-react";
import { type DraftAttachment, useAttachments } from "@/hooks/use-attachments";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { clientError, reportClient } from "@/lib/client-logging";
import { isDraftSaved, useDraft, useRecoveredDraft } from "@/hooks/use-draft";
import { stageMessage, updateDelivery, useThread } from "@/hooks/use-thread";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentBrowser } from "./agent-browser";
import { AgentNavigationContext } from "@/lib/agent-navigation-context";
import { ComposerAttachments } from "./composer-attachments";
import { Conversation } from "./conversation";
import { type FileAttachment } from "@/lib/attachments";
import { NotificationPrompt } from "./notification-prompt";
import { PocketMenu } from "./pocket-menu";
import { connectionStatus } from "@/lib/connection-status";
import { modelDescription } from "@/lib/model-description";
import { post } from "@/lib/client-api";
import { useAppUpdate } from "@/hooks/use-app-update";
import { useComposerViewport } from "@/hooks/use-composer-viewport";
import { usePathname } from "next/navigation";

/**
Require visible text or files and wait until every selected upload has a receipt.
@param text - Draft text proposed for sending.
@param files - Selected draft attachments with their current upload state.
@returns Whether the draft contains a complete sendable payload.
*/
function hasMessage(text: string, files: DraftAttachment[]) {
  return (!!text.trim() || files.length > 0) && files.every((entry) => !!entry.uploaded);
}

/**
Present the first actionable send, attachment or connection error beside the composer.
@param props - Error sources in the order users can act on them.
@returns The shared error alert when any source has failed.
*/
function ComposerError({ errors }: { errors: (string | undefined)[] }) {
  const error = errors.find(Boolean);

  return error ? (
    <Alert variant="destructive" className="mb-3">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;
}

/**
Compose the active parent conversation, durable draft, uploads and message delivery controls.
@returns The parent chat and its existing navigation, notices and composer.
*/
export function Chat() {
  const { state, connected: streamConnected } = useThread();
  const [draft, setDraft] = useDraft();
  const isViewingFile = usePathname() === "/files";
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [pocketsOpen, setPocketsOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const agentReturnFocus = useRef<HTMLElement | null>(null);
  const openAgent = useCallback((id: string, trigger: HTMLButtonElement) => {
    agentReturnFocus.current = trigger;
    setSelectedAgent(id);
    setAgentsOpen(true);
  }, []);
  const messageId = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const filePicker = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(state.threadId);
  const isConnected = streamConnected && state.connection === "connected";
  const status = connectionStatus(state, streamConnected);

  const agentControl = (
    <AgentBrowser
      open={agentsOpen}
      selectedId={selectedAgent}
      onSelect={setSelectedAgent}
      returnFocusRef={agentReturnFocus}
      onOpenChange={setAgentsOpen}
    />
  );

  useAppUpdate(
    () =>
      !sending &&
      !pocketsOpen &&
      state.queue.every((message) => !(message.status === "unknown" || message.status === "sending")) &&
      isDraftSaved(draft) &&
      attachments.canReload()
  );
  useComposerViewport(textarea);

  useRecoveredDraft(attachments.pending, draft, sending, setDraft);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js").catch(console.error);
    }
  }, []);

  async function postPreparedDraft(id: string, text: string, files: FileAttachment[]) {
    await attachments.rememberSend(id, text);
    stageMessage(id, text, files);
    setDraft("");

    return post("/api/messages", { id, text, attachments: files.map((file) => file.id) });
  }

  async function completeDelivery(id: string, text: string, files: FileAttachment[]) {
    const result = await postPreparedDraft(id, text, files);

    if (result.status === "unknown") {
      throw new Error("Delivery is uncertain. Check the conversation on your computer before sending again.");
    }

    updateDelivery(id, result.status === "sent" ? "sent" : "queued");
    reportClient("message.acknowledged", { id, status: result.status });
    await attachments.clear();
    messageId.current = null;
    textarea.current?.focus();
  }

  async function deliverDraft(text: string) {
    const files = attachments.files.flatMap((entry) => (entry.uploaded ? [entry.uploaded] : []));
    const id = (messageId.current ??=
      attachments.pending?.text === text ? attachments.pending.id : crypto.randomUUID());

    reportClient("message.send", { id, text, activeTurnId: state.activeTurnId });
    setSending(true);
    setError("");

    try {
      await completeDelivery(id, text, files);
    } catch (error_) {
      reportClient("message.failed", { id, ...clientError(error_) }, "error");
      updateDelivery(id, "unknown");
      setDraft(text);
      setError(error_ instanceof Error ? error_.message : "Couldn't send. Try again when connected.");
    } finally {
      setSending(false);
    }
  }

  async function send() {
    const text = draft.trim();

    if (sending || !isConnected || !attachments.ready || !hasMessage(text, attachments.files)) {
      return;
    }

    await deliverDraft(text);
  }

  return (
    <AgentNavigationContext value={openAgent}>
      <main className="chat-shell">
        <PocketMenu model={modelDescription(state)} status={status} onOpenChange={setPocketsOpen} />
        <Conversation
          state={state}
          suspended={agentsOpen || pocketsOpen || isViewingFile}
          activityControl={agentControl}
        />
        <footer className="composer-wrap">
          <NotificationPrompt />
          <ComposerError errors={[error, attachments.error, state.error]} />
          <ComposerAttachments
            files={attachments.files}
            disabled={sending}
            remove={async (id) => {
              messageId.current = null;
              await attachments.remove(id);
            }}
            retry={attachments.retry}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <FieldGroup>
              <Field>
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
                      disabled={!hasMessage(draft, attachments.files) || sending || !isConnected || !attachments.ready}
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
    </AgentNavigationContext>
  );
}
