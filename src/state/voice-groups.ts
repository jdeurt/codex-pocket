import { type VoiceSegment } from "../lib/voice-history";

const MISSING = -1;

export interface VoiceGroup extends VoiceSegment {
  sourceIds: string[];
}

/** Compare media positions only within the same Live call.
@param left - Earlier candidate.
@param right - Later candidate.
@returns Session-local media ordering, retaining legacy insertion order.
*/
function compareGroups(left: VoiceSegment, right: VoiceSegment) {
  return left.groupId && right.groupId && left.nativeSessionId === right.nativeSessionId
    ? (left.startMs ?? 0) - (right.startMs ?? 0)
    : 0;
}

/** Start a display candidate from one immutable fragment, independently of transport grouping hints.
@param fragment - Exact observed caption.
@returns Candidate carrying both native and historical group identities.
*/
function fragmentGroup(fragment: VoiceSegment): VoiceGroup {
  return { ...fragment, sourceIds: [fragment.id, fragment.groupId ?? fragment.id] };
}

/** Distinguish words from bracketed non-speech captions, including incomplete annotations.
@param text - Accumulated display text.
@returns Whether this group contains speech rather than only noise or punctuation.
*/
function hasSpeech(text: string) {
  return /[\p{L}\p{N}]/u.test(text.replaceAll(/\[[^\]]*(?:\]|$)/g, ""));
}

/** Recognize punctuation belonging to the preceding speaker bubble.
@param previous - Earlier text from the same speaker.
@param text - New native group text.
@returns Continuation prefix that must stay with the preceding bubble.
*/
function continuationPrefix(previous: string, text: string) {
  if (previous.lastIndexOf("[") > previous.lastIndexOf("]")) {
    const closing = text.indexOf("]");

    return closing === MISSING ? text : text.slice(0, closing + 1);
  }

  return /^[\s]*[.,!?;:…]+[\s.,!?;:…]*/u.exec(text)?.[0] ?? "";
}

/** Decide whether intervening actual speech starts a new bubble for this speaker.
@param previous - Previous same-speaker group.
@param other - Latest opposite-speaker group in this call.
@param current - Next candidate.
@returns Whether the opposite speaker spoke between the two candidates.
*/
function hasInterveningSpeech(previous: VoiceGroup, other: VoiceGroup | undefined, current: VoiceGroup) {
  return (
    other !== undefined &&
    (other.startMs ?? 0) >= (previous.startMs ?? 0) &&
    (current.startMs ?? 0) >= (other.endMs ?? 0) &&
    hasSpeech(other.text)
  );
}

/** Remove only display-edge whitespace, retaining original ledger text untouched.
@param group - Assembled speaker bubble.
@returns Left-aligned display text.
*/
function displayGroup(group: VoiceGroup): VoiceGroup {
  return { ...group, text: group.text.trim() };
}

/** Derive conversational bubbles from exact fragments without treating pauses or noise as turns.
@param segments - Immutable observed captions with canonical boundary anchors.
@returns Speaker bubbles and all original identities used by restart anchors.
*/
export function groupedVoiceSegments(segments: readonly VoiceSegment[]): VoiceGroup[] {
  const ordered = Array.from(segments, fragmentGroup.bind(undefined)).toSorted(compareGroups);
  const result: VoiceGroup[] = [];
  const latest = new Map<string, number>();

  for (const group of ordered) {
    const key = `${group.nativeSessionId}:${group.role}`;
    const index = latest.get(key);
    const previous = index === undefined ? undefined : result[index];
    const otherIndex = latest.get(`${group.nativeSessionId}:${group.role === "user" ? "assistant" : "user"}`);
    const other = otherIndex === undefined ? undefined : result[otherIndex];
    const canContinue = !!previous?.groupId && !!group.groupId && previous.afterItemId === group.afterItemId;

    if (previous && index !== undefined && canContinue) {
      const prefix = continuationPrefix(previous.text, group.text);
      const shouldMerge = prefix === group.text || !hasInterveningSpeech(previous, other, group);

      result[index] = {
        ...previous,
        text: previous.text + (shouldMerge ? group.text : prefix),
        ...(shouldMerge && { endMs: group.endMs, sourceIds: [...previous.sourceIds, ...group.sourceIds] }),
      };

      if (shouldMerge) {
        continue;
      }

      latest.set(key, result.length);
      result.push({ ...group, text: group.text.slice(prefix.length) });

      continue;
    }

    latest.set(key, result.length);
    result.push(group);
  }

  return Array.from(result, displayGroup.bind(undefined));
}
