import { type Data, object, string } from "../lib/protocol";

const LIVE_CAPTION_LIMIT = 256;

type Role = "user" | "assistant";
export interface LiveCaptionState {
  anchors: ReadonlyMap<string, string | null>;
  lastCanonical?: string | null;
  lastVoice?: string;
  partial: ReadonlyMap<string, string>;
  captions: ReadonlyMap<string, Data>;
}
export interface CaptionTransition {
  state: LiveCaptionState;
  frame?: Data;
  final?: { event: Data; sessionId: string; role: Role; afterItemId: string | null };
}

/** Create a session-local caption projection without reading history or media.
@returns Empty independent caption state.
*/
export function liveCaptionState(): LiveCaptionState {
  return { anchors: new Map(), partial: new Map(), captions: new Map() };
}

/** Select only events that can introduce a new speech identity.
@param event - Provider metadata event.
@returns Native item identity and speaker, when an anchor can be needed.
*/
function captionIdentity(event: Data): { itemId: string; role: Role } | undefined {
  switch (event.type) {
    case "response.output_item.added": {
      const item = object(event.item);

      return item.type === "message" && item.role === "assistant"
        ? { itemId: string(item.id), role: "assistant" }
        : undefined;
    }

    case "input_audio_buffer.speech_started":
    case "input_audio_buffer.committed":
    case "conversation.item.input_audio_transcription.completed":
    case "conversation.item.input_audio_transcription.delta": {
      return { itemId: string(event.item_id), role: "user" };
    }

    case "response.output_audio_transcript.done":
    case "response.output_audio_transcript.delta": {
      return { itemId: string(event.item_id), role: "assistant" };
    }
  }
}

/** Request canonical history only for a speech identity's first observation.
@param state - Existing immutable caption anchors.
@param event - Provider event, including unrelated media/control metadata.
@param sessionId - Native call identity.
@returns Whether the runtime needs to read the canonical transcript boundary.
*/
export function shouldAnchorCaption(state: LiveCaptionState, event: Data, sessionId: string) {
  const identity = captionIdentity(event);

  return identity !== undefined && !state.anchors.has(`realtime:${sessionId}:${identity.itemId}:${identity.role}`);
}

/** Anchor native speech to explicit canonical history before its captions arrive.
@param state - Previous caption projection.
@param itemId - Native speech identity.
@param sessionId - Native session identity.
@param role - Speaker.
@param canonical - Latest canonical chat item at observation time.
@returns Independent state with an immutable first-observation anchor.
*/
function anchoredCaption(
  state: LiveCaptionState,
  itemId: string,
  sessionId: string,
  role: Role,
  canonical: string | null
): LiveCaptionState {
  const id = `realtime:${sessionId}:${itemId}:${role}`;

  if (state.anchors.has(id)) {
    return state;
  }

  const anchors = new Map(state.anchors);

  anchors.set(id, state.lastCanonical === canonical ? (state.lastVoice ?? canonical) : canonical);

  return { ...state, anchors, lastCanonical: canonical, lastVoice: id };
}

/** Project a partial or finalized provider caption without affecting audio flow.
@param state - Previous caption projection.
@param event - Provider transcript event.
@param sessionId - Native call identity.
@param role - Speaker.
@param canonical - Canonical item observed by the runtime.
@param isDone - Whether the provider finalized this caption.
@returns UI frame and an optional independent persistence command.
*/
function captionReply(
  state: LiveCaptionState,
  event: Data,
  sessionId: string,
  role: Role,
  canonical: string | null,
  isDone: boolean
): CaptionTransition {
  const itemId = string(event.item_id);
  const next = anchoredCaption(state, itemId, sessionId, role, canonical);
  const id = `realtime:${sessionId}:${itemId}:${role}`;
  const afterItemId = next.anchors.get(id) ?? null;
  const text = isDone ? string(event.transcript) : (next.partial.get(itemId) ?? "") + string(event.delta);
  const partial = new Map(next.partial);

  if (isDone) {
    partial.delete(itemId);
  } else {
    partial.set(itemId, text);
  }

  const frame = {
    type: isDone ? "transcriptDone" : "transcriptDelta",
    id,
    itemId,
    nativeSessionId: sessionId,
    role,
    text,
    done: isDone,
    afterItemId,
  };
  const captions = new Map(next.captions);

  captions.set(id, frame);

  if (captions.size > LIVE_CAPTION_LIMIT) {
    captions.delete(captions.keys().next().value ?? "");
  }

  return {
    state: { ...next, partial, captions },
    frame,
    ...(isDone && { final: { event, sessionId, role, afterItemId } }),
  };
}

/** Interpret only speech identity and caption events from the provider control stream.
@param state - Previous session-local caption projection.
@param event - Original provider control frame.
@param sessionId - Current native call identity.
@param canonical - Explicit latest canonical item.
@returns Immutable state and optional display/persistence effects.
*/
export function receivedCaption(
  state: LiveCaptionState,
  event: Data,
  sessionId: string,
  canonical: string | null
): CaptionTransition {
  switch (event.type) {
    case "response.output_item.added": {
      const item = object(event.item);

      return {
        state:
          item.type === "message" && item.role === "assistant"
            ? anchoredCaption(state, string(item.id), sessionId, "assistant", canonical)
            : state,
      };
    }

    case "input_audio_buffer.speech_started":
    case "input_audio_buffer.committed": {
      return { state: anchoredCaption(state, string(event.item_id), sessionId, "user", canonical) };
    }

    case "conversation.item.input_audio_transcription.failed": {
      return {
        state,
        frame: { type: "warning", error: "Some captions are unavailable. Your live audio is still connected." },
      };
    }

    case "conversation.item.input_audio_transcription.completed": {
      return captionReply(state, event, sessionId, "user", canonical, true);
    }

    case "response.output_audio_transcript.done": {
      return captionReply(state, event, sessionId, "assistant", canonical, true);
    }

    case "conversation.item.input_audio_transcription.delta": {
      return captionReply(state, event, sessionId, "user", canonical, false);
    }

    case "response.output_audio_transcript.delta": {
      return captionReply(state, event, sessionId, "assistant", canonical, false);
    }

    default: {
      return { state };
    }
  }
}
