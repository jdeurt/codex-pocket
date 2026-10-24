import { type VoiceSegment } from "../lib/voice-history";

const LAST_FRAGMENT = -1;

export type VoicePhase = "idle" | "starting" | "active" | "stopping";
export interface VoiceState {
  state: VoicePhase;
  error: string;
  historyError: string;
  segments: VoiceSegment[];
}

/** Create caption and lifecycle data without retaining media resources.
@param segments - Finalized captions from server hydration.
@returns Initial idle voice projection.
*/
export function voiceState(segments: VoiceSegment[] = []): VoiceState {
  return { state: "idle", error: "", historyError: "", segments };
}

/** Merge captions by identity, retaining final text over late partial events.
@param segments - Existing captions, left unchanged.
@param entries - Incoming live or saved captions, left unchanged.
@returns Merged captions in stable insertion order.
*/
export function reconcileCaptions(segments: VoiceSegment[], entries: VoiceSegment[]): VoiceSegment[] {
  const merged = new Map<string, VoiceSegment>();

  for (const entry of segments) {
    merged.set(entry.id, entry);
  }

  for (const entry of entries) {
    if (!merged.get(entry.id)?.done || entry.done) {
      merged.set(entry.id, entry);
    }
  }

  return merged.values().toArray();
}

/** Order observed fragment timing while retaining legacy insertion order on equal starts.
@param left - First immutable caption fragment.
@param right - Second immutable caption fragment.
@returns Session-local timestamp order.
*/
function compareFragments(left: VoiceSegment, right: VoiceSegment) {
  return (left.startMs ?? 0) - (right.startMs ?? 0);
}

/** Read a stable display-group identity without changing a saved fragment.
@param segment - Immutable provider fragment or legacy caption.
@returns Shared bubble identity.
*/
function voiceGroupId(segment: VoiceSegment) {
  return segment.groupId ?? segment.id;
}

/** Select exact text from an immutable provider fragment.
@param segment - Observed fragment.
@returns Unmodified provider text.
*/
function fragmentText(segment: VoiceSegment) {
  return segment.text;
}

/** Order groups within one Live session by media time while retaining session and legacy order.
@param left - First display group.
@param right - Second display group.
@returns Session-local media ordering, or stable original order across calls.
*/
function compareVoiceGroups(left: VoiceSegment, right: VoiceSegment) {
  return left.groupId && right.groupId && left.nativeSessionId === right.nativeSessionId
    ? compareFragments(left, right)
    : 0;
}

/** Group immutable Live fragments for display without changing saved speech or legacy records.
@param segments - Persisted or immediately published caption fragments.
@returns Stable speaker bubbles that can grow independently during overlapping speech.
*/
export function groupedVoiceSegments(segments: readonly VoiceSegment[]): VoiceSegment[] {
  const groups = Map.groupBy(segments, voiceGroupId.bind(undefined));

  const result: VoiceSegment[] = [];

  for (const [id, fragments] of groups) {
    const ordered = fragments.toSorted(compareFragments);
    const first = ordered[0];
    const text = Array.from(ordered, fragmentText.bind(undefined));

    result.push({ ...first, id, text: text.join(""), endMs: ordered.at(LAST_FRAGMENT)?.endMs });
  }

  return result.toSorted(compareVoiceGroups);
}
