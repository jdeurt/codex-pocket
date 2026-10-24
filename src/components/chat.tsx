"use client";
import "./focused-composer.css";
import { ComposerError } from "./composer-error";
import { ArrowUpIcon, MicIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useAttachments } from "@/hooks/use-attachments";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { useDraft } from "@/hooks/use-draft";
import { useThread } from "@/hooks/use-thread";
import { useCallback, useRef, useState } from "react";
import { AgentBrowser } from "./agent-browser";
import { AgentNavigationContext } from "@/lib/agent-navigation-context";
import { ComposerAttachments } from "./composer-attachments";
import { Conversation } from "./conversation";
import { NotificationPrompt } from "./notification-prompt";
import { PocketMenu } from "./pocket-menu";
import { RealtimeSpectrum } from "./realtime-spectrum";
import { connectionStatus } from "@/lib/connection-status";
import { modelDescription } from "@/lib/model-description";
import { useAppUpdate } from "@/hooks/use-app-update";
import { useComposerViewport } from "@/hooks/use-composer-viewport";
import { usePocketSettings } from "@/hooks/use-pocket-settings";
import { usePathname } from "next/navigation";
import { useStore } from "zustand";
import { usePocketClient } from "@/providers/pocket-state";
import { useRealtime } from "@/hooks/use-realtime";
import { useVoiceGesture } from "@/hooks/use-voice-gesture";

/**
Show the send arrow, armed microphone, or realtime stop icon in one button.
@param props - Whether realtime is active or the upward gesture is armed.
@returns The current icon for the send button.
*/
function SendControlIcon({ active, armed }: { active: boolean; armed: boolean }) {
  if (active) {
    return <XIcon aria-hidden="true" />;
  }

  return armed ? <MicIcon aria-hidden="true" /> : <ArrowUpIcon aria-hidden="true" />;
}

/**
Compose the active parent conversation, durable draft, uploads and message delivery controls.
@returns The parent chat and its existing navigation, notices and composer.
*/
// eslint-disable-next-line complexity, react-doctor/no-high-complexity-react-function -- Existing chat owns composer, uploads, navigation, and the new voice control.
export function Chat() {
  const { state, connected: streamConnected } = useThread();
  const settings = usePocketSettings();
  const [draft, setDraft] = useDraft();
  const isViewingFile = usePathname() === "/files";
  const client = usePocketClient();
  const { busy: sending, error } = useStore(client.delivery.store);
  const draftHydration = useStore(client.draft.hydration);
  const voice = useRealtime(state.connection === "connected" ? state.threadId : undefined);
  const [voiceHeight, setVoiceHeight] = useState<number>();
  const isVoiceActive = voice.state !== "idle";
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [pocketsOpen, setPocketsOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const agentReturnFocus = useRef<HTMLElement | null>(null);
  const openAgent = useCallback((id: string, trigger: HTMLButtonElement) => {
    agentReturnFocus.current = trigger;
    setSelectedAgent(id);
    setAgentsOpen(true);
  }, []);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const filePicker = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(state.threadId);
  const canSendAttachments = attachments.ready && attachments.files.every((file) => !!file.uploaded);
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

  useAppUpdate(() => !pocketsOpen && client.canReload());
  useComposerViewport(textarea);

  async function send() {
    if (await client.delivery.send()) {
      textarea.current?.focus();
    }
  }

  const startVoice = () => {
    setVoiceHeight(textarea.current?.closest(".composer")?.getBoundingClientRect().height);
    void voice.start();
  };
  const voiceGesture = useVoiceGesture({
    active: isVoiceActive,
    enabled: isConnected,
    onTap: () => {
      void send();
    },
    onStart: startVoice,
    onStop: () => {
      void voice.stop();
    },
  });

  return (
    <AgentNavigationContext value={openAgent}>
      <main className="chat-shell">
        <PocketMenu model={modelDescription(state)} status={status} onOpenChange={setPocketsOpen} />
        <Conversation
          state={state}
          realtimeSegments={voice.segments}
          suspended={agentsOpen || pocketsOpen || isViewingFile}
          activityControl={agentControl}
          showTools={settings.data?.showToolCalls ?? false}
        />
        <footer className="composer-wrap">
          <NotificationPrompt />
          <ComposerError
            errors={[
              voice.error,
              error,
              draftHydration.error,
              attachments.error,
              state.error,
              state.connectionRetry?.message,
            ]}
            dismissVoiceError={voice.error ? voice.dismissError : undefined}
          />
          {!isVoiceActive && (
            <ComposerAttachments
              files={attachments.files}
              disabled={sending}
              remove={async (id) => {
                client.delivery.reset();
                await attachments.remove(id);
              }}
              retry={attachments.retry}
            />
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();

              if (!isVoiceActive) {
                void send();
              }
            }}
          >
            {!isVoiceActive && (
              <button type="button" className="voice-keyboard-control" onClick={startVoice} disabled={!isConnected}>
                Start realtime voice
              </button>
            )}
            <FieldGroup>
              <Field>
                <input
                  ref={filePicker}
                  type="file"
                  multiple
                  hidden
                  aria-label="Choose attachments"
                  disabled={isVoiceActive || sending || !attachments.ready || state.connection === "unconfigured"}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];

                    event.target.value = "";
                    client.delivery.reset();
                    void attachments.add(files);
                  }}
                />
                <FieldLabel className="sr-only" htmlFor="message">
                  Message Pocket
                </FieldLabel>
                <InputGroup className="composer" style={{ height: isVoiceActive ? voiceHeight : undefined }}>
                  {isVoiceActive ? (
                    <RealtimeSpectrum input={voice.inputAnalyser} output={voice.outputAnalyser} status={voice.state} />
                  ) : (
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
                        client.delivery.reset();
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
                  )}
                  <InputGroupAddon align="inline-end">
                    {!isVoiceActive && (
                      <>
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
                      </>
                    )}
                    <InputGroupButton
                      type="button"
                      variant="default"
                      size="icon-sm"
                      className={`send-button ${voiceGesture.holding ? "send-button-holding" : ""}`}
                      style={
                        voiceGesture.holding
                          ? { transform: `translateY(-${String(voiceGesture.offset)}px)` }
                          : undefined
                      }
                      aria-label={
                        isVoiceActive ? "Stop realtime voice" : "Send message; hold and swipe up for realtime voice"
                      }
                      disabled={
                        voice.state === "stopping" ||
                        (!isVoiceActive && (sending || !isConnected || !canSendAttachments))
                      }
                      onPointerDown={voiceGesture.onPointerDown}
                      onPointerMove={voiceGesture.onPointerMove}
                      onPointerUp={voiceGesture.onPointerUp}
                      onLostPointerCapture={voiceGesture.onLostPointerCapture}
                      onPointerCancel={voiceGesture.onPointerCancel}
                      onClick={voiceGesture.onClick}
                    >
                      <SendControlIcon active={isVoiceActive} armed={voiceGesture.armed} />
                    </InputGroupButton>
                    {voiceGesture.holding && <span className="voice-pill-track" aria-hidden="true" />}
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
