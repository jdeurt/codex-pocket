import { z } from "zod";
import { type Data } from "../lib/protocol";
import { type VoiceSegment } from "../lib/voice-history";

const LIVE_CAPTION_LIMIT = 2048;
const DISPLAY_GAP_MS = 1500;

type Role = "user" | "assistant";
export const liveTranscriptSchema = z.object({
  type: z.enum(["session.input_transcript.delta", "session.output_transcript.delta"]),
  event_id: z.string().min(1),
  delta: z.string().min(1),
  start_ms: z.number().nonnegative(),
  end_ms: z.number().nonnegative(),
});

type Fragment = z.infer<typeof liveTranscriptSchema>;
interface CaptionGroup {
  id: string;
  startMs: number;
  endMs: number;
  afterItemId: string | null;
}
export interface LiveCaptionState {
  boundary?: string;
  groups: ReadonlyMap<Role, CaptionGroup>;
  captions: ReadonlyMap<string, VoiceSegment>;
}
export interface CaptionTransition {
  state: LiveCaptionState;
  frame?: Data;
  final?: VoiceSegment;
}

/** Allocate an independent ledger of immutable Live fragments and display grouping metadata.
@returns Empty call-local caption state.
*/
export function liveCaptionState(): LiveCaptionState {
  return { groups: new Map(), captions: new Map() };
}

/** Reserve a canonical boundary before restart persistence can yield to later fragments.
@param state - Observed fragment ledger.
@param id - Explicit new canonical notice identity.
@returns State that starts subsequent speech groups after that notice.
*/
export function openedCaptionBoundary(state: LiveCaptionState, id: string): LiveCaptionState {
  return { ...state, groups: new Map(), boundary: id };
}

/** Release an override after canonical state has accepted its notice, retaining split groups.
@param state - Observed fragments and temporary boundary.
@param id - Completed boundary operation.
@returns State without that operation's temporary override.
*/
export function closedCaptionBoundary(state: LiveCaptionState, id: string): LiveCaptionState {
  return state.boundary === id ? { ...state, boundary: undefined } : state;
}

/** Select the speaker from an already validated native transcript event.
@param event - GPT-Live transcript fragment.
@returns User or assistant identity.
*/
function fragmentRole(event: Fragment): Role {
  return event.type === "session.input_transcript.delta" ? "user" : "assistant";
}

/** Decide bubble boundaries from media timestamps, independently of audio scheduling.
@param state - Current speaker groups.
@param event - Validated immutable transcript fragment.
@returns Whether to create a new speaker bubble.
*/
function shouldStartGroup(state: LiveCaptionState, event: Fragment) {
  const role = fragmentRole(event);
  const group = state.groups.get(role);
  const other = state.groups.get(role === "user" ? "assistant" : "user");

  return (
    !group ||
    event.start_ms - group.endMs > DISPLAY_GAP_MS ||
    (other !== undefined && other.startMs >= group.endMs && event.start_ms >= other.endMs)
  );
}

/** Read canonical history only when a new display group needs a predecessor anchor.
@param state - Current call-local groups and seen fragments.
@param event - Provider event.
@param sessionId - Owning local call identity.
@returns Whether the runtime needs the latest canonical boundary.
*/
export function shouldAnchorCaption(state: LiveCaptionState, event: Data, sessionId: string) {
  const parsed = liveTranscriptSchema.safeParse(event);

  return (
    parsed.success &&
    parsed.data.start_ms <= parsed.data.end_ms &&
    !state.captions.has(`live:${sessionId}:${parsed.data.event_id}`) &&
    shouldStartGroup(state, parsed.data)
  );
}

/** Encode one immutable observed fragment for immediate UI publication.
@param entry - Exact provider text and timestamp metadata.
@returns The existing caption transport envelope.
*/
export function captionFrame(entry: VoiceSegment): Data {
  return { type: "transcriptDone", ...entry };
}

/** Publish and persist observed fragments without inventing completed spoken turns.
@param state - Previous caption ledger.
@param event - Native GPT-Live event.
@param sessionId - Owning local call identity.
@param canonical - Canonical boundary, read only for a new group.
@returns Immutable caption state and independent display/storage effects.
*/
export function receivedCaption(
  state: LiveCaptionState,
  event: Data,
  sessionId: string,
  canonical: string | null
): CaptionTransition {
  const parsed = liveTranscriptSchema.safeParse(event);

  if (!parsed.success || parsed.data.end_ms < parsed.data.start_ms) {
    return { state };
  }

  const fragment = parsed.data;
  const id = `live:${sessionId}:${fragment.event_id}`;

  if (state.captions.has(id)) {
    return { state };
  }

  const role = fragmentRole(fragment);
  const isNew = shouldStartGroup(state, fragment);
  const previous = state.groups.get(role);
  const group =
    isNew || !previous
      ? {
          id,
          startMs: fragment.start_ms,
          endMs: fragment.end_ms,
          afterItemId: canonical,
        }
      : { ...previous, endMs: Math.max(previous.endMs, fragment.end_ms) };
  const entry: VoiceSegment = {
    id,
    itemId: fragment.event_id,
    nativeSessionId: sessionId,
    role,
    text: fragment.delta,
    done: true,
    groupId: group.id,
    startMs: fragment.start_ms,
    endMs: fragment.end_ms,
    afterItemId: group.afterItemId,
  };
  const groups = new Map(state.groups);
  const captions = new Map(state.captions);

  groups.set(role, group);
  captions.set(id, entry);

  if (captions.size > LIVE_CAPTION_LIMIT) {
    captions.delete(captions.keys().next().value ?? "");
  }

  return {
    state: {
      groups,
      captions,
    },
    frame: captionFrame(entry),
    final: entry,
  };
}
