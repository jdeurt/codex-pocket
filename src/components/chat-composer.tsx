"use client";
import "./focused-composer.css";
import { ComposerError } from "./composer-error";
import { ArrowUpIcon, MicIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useAttachments } from "@/hooks/use-attachments";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { useDraft } from "@/hooks/use-draft";
import { useRef, useState } from "react";
import { ComposerAttachments } from "./composer-attachments";
import { NotificationPrompt } from "./notification-prompt";
import { RealtimeSpectrum } from "./realtime-spectrum";
import { useComposerViewport } from "@/hooks/use-composer-viewport";
import { useStore } from "zustand";
import { usePocketClient } from "@/providers/pocket-state";
import type { useRealtime } from "@/hooks/use-realtime";
import { useBoundCallback } from "@/hooks/use-bound-callback";
import {
  requestMessage,
  startChatVoice,
  stopChatVoice,
  removeChatAttachment,
  submitChat,
  chooseChatAttachments,
  editChatDraft,
  chatKeyDown,
  openFilePicker,
} from "@/runtime/chat-composer";
import { hasUploadedAttachment } from "@/state/attachments";
import { useVoiceGesture } from "@/hooks/use-voice-gesture";

import type { Snapshot } from "@/lib/protocol";

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

/** Render the shared send and voice-gesture control from explicit view state.
@param props - Gesture projection, active voice state and availability.
@returns Accessible send/stop control and gesture track.
*/
function VoiceSendControl({
  gesture,
  active,
  disabled,
}: {
  gesture: ReturnType<typeof useVoiceGesture>;
  active: boolean;
  disabled: boolean;
}) {
  return (
    <>
      <InputGroupButton
        type="button"
        variant="default"
        size="icon-sm"
        className={`send-button ${gesture.holding ? "send-button-holding" : ""}`}
        style={gesture.holding ? { transform: `translateY(-${String(gesture.offset)}px)` } : undefined}
        aria-label={active ? "Stop realtime voice" : "Send message; hold and swipe up for realtime voice"}
        disabled={disabled}
        onPointerDown={gesture.onPointerDown}
        onPointerMove={gesture.onPointerMove}
        onPointerUp={gesture.onPointerUp}
        onLostPointerCapture={gesture.onLostPointerCapture}
        onPointerCancel={gesture.onPointerCancel}
        onClick={gesture.onClick}
      >
        <SendControlIcon active={active} armed={gesture.armed} />
      </InputGroupButton>
      {gesture.holding && <span className="voice-pill-track" aria-hidden="true" />}
    </>
  );
}

/** Render the composer using scoped service state and component-local layout/focus state.
@param props - Canonical conversation, voice projection and current transport availability.
@returns Message and voice controls with their existing keyboard and pointer behavior.
*/
export function ChatComposer({
  state,
  voice,
  isConnected,
}: {
  state: Snapshot;
  voice: ReturnType<typeof useRealtime>;
  isConnected: boolean;
}) {
  const [draft] = useDraft();
  const client = usePocketClient();
  const { busy: sending, error } = useStore(client.delivery.store);
  const draftHydration = useStore(client.draft.hydration);
  const [voiceHeight, setVoiceHeight] = useState<number>();
  const isVoiceActive = voice.state !== "idle";
  const textarea = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(state.threadId);
  const canSendAttachments = attachments.ready && attachments.files.every(hasUploadedAttachment);
  const isInputDisabled = state.connection === "unconfigured" || sending;
  const canAttach = !isInputDisabled && attachments.ready;

  useComposerViewport(textarea);

  const send = useBoundCallback(requestMessage, client, textarea);
  const startVoice = useBoundCallback(startChatVoice, client, textarea, setVoiceHeight);
  const openPicker = useBoundCallback(openFilePicker, filePicker);
  const voiceGesture = useVoiceGesture({
    active: isVoiceActive,
    enabled: isConnected,
    onTap: send,
    onStart: startVoice,
    onStop: stopChatVoice.bind(undefined, client),
  });

  return (
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
          remove={removeChatAttachment.bind(undefined, client)}
          retry={attachments.retry}
        />
      )}
      <form onSubmit={submitChat.bind(undefined, send, isVoiceActive)}>
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
              disabled={isVoiceActive || !canAttach}
              onChange={chooseChatAttachments.bind(undefined, client)}
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
                  disabled={isInputDisabled}
                  onChange={editChatDraft.bind(undefined, client)}
                  onKeyDown={chatKeyDown.bind(undefined, send)}
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
                      disabled={!canAttach}
                      onClick={openPicker}
                    >
                      <PaperclipIcon aria-hidden="true" />
                    </InputGroupButton>
                  </>
                )}
                <VoiceSendControl
                  gesture={voiceGesture}
                  active={isVoiceActive}
                  disabled={
                    voice.state === "stopping" || (!isVoiceActive && (sending || !isConnected || !canSendAttachments))
                  }
                />
              </InputGroupAddon>
            </InputGroup>
          </Field>
        </FieldGroup>
      </form>
    </footer>
  );
}
