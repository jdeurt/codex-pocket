import { type Item, string } from "./protocol";
import { rowsForTurns, type TranscriptTurn } from "./transcript-virtualization";
import { type VoiceSegment } from "./voice-history";
import { hasMessageText } from "./turn-messages";
import { groupedVoiceSegments } from "../state/voice";
import { type VoiceGroup } from "../state/voice-groups";

interface AnchoredTurn {
  id: string;
  afterItemId?: string | null;
  turn: TranscriptTurn;
}

/** Keep prior speech before sibling notices when legacy caption identities have merged.
@param left - Anchored speech or restart row.
@param right - Other anchored row.
@returns Stable voice-first order; dependency traversal still places later speech after notices.
*/
function compareAnchoredEntries(left: AnchoredTurn, right: AnchoredTurn) {
  const first = left.turn.entries[0];
  const second = right.turn.entries[0];

  return (
    Number(first.kind === "message" && first.item.type === "pocketRestart") -
    Number(second.kind === "message" && second.item.type === "pocketRestart")
  );
}

/** Resolve timeline anchors without recursion, preserving cycle and missing-anchor fallbacks.
@param id - Anchor to resolve.
@param positions - Canonical message positions.
@param anchors - Voice and restart predecessor relationships.
@param tail - Position after the last canonical row.
@returns The insertion boundary for this entry.
*/
function anchorPosition(
  id: string | null | undefined,
  positions: ReadonlyMap<string, number>,
  anchors: ReadonlyMap<string, string | null | undefined>,
  tail: number
) {
  const seen = new Set<string>();

  while (id && !seen.has(id)) {
    const position = positions.get(id);

    if (position !== undefined) {
      return position;
    }

    seen.add(id);
    id = anchors.get(id);
  }

  return id === null ? 0 : tail;
}

/** Order voice and restart dependencies before their descendants.
@param segments - Anchored timeline entries in stable source order.
@param aliases - Original caption identities mapped to their current display group.
@returns Entries with each available predecessor before its descendants.
*/
function orderedEntries(segments: AnchoredTurn[], aliases: ReadonlyMap<string, string>) {
  const pending = new Map<string, AnchoredTurn>();
  const ordered: AnchoredTurn[] = [];

  for (const segment of segments) {
    pending.set(segment.id, segment);
  }

  for (const segment of segments) {
    const chain: AnchoredTurn[] = [];

    let current: AnchoredTurn | undefined = segment;

    while (current && pending.delete(current.id)) {
      chain.push(current);
      const predecessor = current.afterItemId ?? "";

      current = pending.get(aliases.get(predecessor) ?? predecessor);
    }

    ordered.push(...chain.toReversed());
  }

  return ordered;
}

/** Read a derived bubble identity before building legacy aliases.
@param group - Visible speaker bubble.
@returns Its stable display identity.
*/
function voiceGroupIdentity(group: VoiceGroup) {
  return group.id;
}

/** Retain original caption identities after display groups merge.
@param segments - Derived bubbles with immutable source identities.
@returns Original identity to current bubble identity lookup.
*/
function voiceAliases(segments: VoiceGroup[]) {
  const aliases = new Map<string, string>();
  const visibleIds = new Set(Array.from(segments, voiceGroupIdentity.bind(undefined)));

  for (const segment of segments) {
    for (const id of segment.sourceIds) {
      if (!visibleIds.has(id)) {
        aliases.set(id, segment.id);
      }
    }
  }

  return aliases;
}

/** Read the durable handoff identity shared by legacy captions and canonical messages.
@param segment - Saved or live caption.
@returns Original delivery identity.
*/
function captionReceipt(segment: VoiceSegment) {
  return segment.handoffId ?? `realtime:${segment.nativeSessionId}:${segment.itemId}`;
}

/** Retain an explicitly anchored restart for the shared dependency ordering.
@param turn - One canonical display row.
@returns Restart dependency when the row carries its combined timeline anchor.
*/
function anchoredRestart(turn: TranscriptTurn): AnchoredTurn | undefined {
  const entry = turn.entries[0];

  if (entry.kind !== "message" || entry.item.type !== "pocketRestart") {
    return;
  }

  const anchor = entry.item.afterItemId;

  if (typeof anchor === "string" || anchor === null) {
    return { id: entry.item.id, afterItemId: anchor, turn };
  }
}

/** Keep nonempty captions whose user receipt is not already displayed.
@param canonical - Native or queued user receipts.
@param segment - Candidate caption.
@returns Whether the caption belongs in the combined transcript.
*/
function isVisibleCaption(canonical: ReadonlySet<string>, segment: VoiceSegment) {
  return !!segment.text.trim() && !(segment.role === "user" && canonical.has(captionReceipt(segment)));
}

/** Recognize a native user receipt with visible text.
@param item - Canonical item.
@returns Whether its identity deduplicates a saved user caption.
*/
function isUserReceipt(item: Item) {
  return item.type === "userMessage" && hasMessageText(item);
}

/** Project timestamp-ordered Live bubbles into predecessor chains shared with restart notices.
@param fragments - Immutable saved or live fragments.
@returns Display-only anchors that preserve media order without rewriting saved evidence.
*/
function anchoredVoiceGroups(fragments: VoiceSegment[]) {
  const groups = groupedVoiceSegments(fragments);
  const anchored: VoiceGroup[] = [];

  let previous: VoiceSegment | undefined;

  for (const group of groups) {
    const shouldChain =
      !!previous?.groupId &&
      !!group.groupId &&
      previous.nativeSessionId === group.nativeSessionId &&
      previous.afterItemId === group.afterItemId;

    anchored.push(previous && shouldChain ? { ...group, afterItemId: previous.id } : group);
    previous = group;
  }

  return anchored;
}

/** Order speech and restart notices at durable anchors, retaining native order and receipt identity.
@param turns - Canonical main-agent rows in their authoritative order.
@param fragments - Immutable Live fragments or legacy speech entries.
@param queued - Receipts still owned by the main outbox.
@returns One transcript for voice and main-agent messages without text-based deduplication.
*/
export function voiceTimeline(turns: TranscriptTurn[], fragments: VoiceSegment[], queued: string[]) {
  const segments = anchoredVoiceGroups(fragments);
  const canonical = new Set(queued);
  const positions = new Map<string, number>();
  const receipts = new Map<string, number>();
  const rows: TranscriptTurn[] = [];
  const anchored: AnchoredTurn[] = [];

  for (const row of rowsForTurns(turns)) {
    const entry = row.entry;

    const turn = { id: row.turnId, entries: [entry] };

    const restart = anchoredRestart(turn);

    if (restart) {
      anchored.push(restart);

      continue;
    }

    rows.push(turn);
    const items = entry.kind === "message" ? [entry.item] : entry.items;

    for (const item of items) {
      positions.set(item.id, rows.length);

      if (!isUserReceipt(item)) {
        continue;
      }

      canonical.add(item.id);
      canonical.add(string(item.clientId));
    }

    if (entry.kind === "message" && hasMessageText(entry.item)) {
      for (const id of [entry.item.id, string(entry.item.clientId)]) {
        if (!receipts.has(id)) {
          receipts.set(id, rows.length);
        }
      }
    }
  }

  const aliases = voiceAliases(segments);
  const anchors = new Map<string, string | null | undefined>(aliases);

  for (const segment of segments) {
    anchors.set(segment.id, segment.afterItemId);

    const position = receipts.get(captionReceipt(segment));

    if (position !== undefined) {
      positions.set(segment.id, position);
    }
  }

  for (const segment of segments) {
    if (!isVisibleCaption(canonical, segment)) {
      continue;
    }

    const item: Item = { id: segment.id, type: "voiceMessage", voice: segment };

    anchored.push({ ...segment, turn: { id: segment.id, entries: [{ kind: "message", item }] } });
  }

  for (const entry of anchored) {
    anchors.set(entry.id, entry.afterItemId);
  }

  const buckets = new Map<number, TranscriptTurn[]>();
  const ordered = orderedEntries(anchored.toSorted(compareAnchoredEntries), aliases);

  for (const entry of ordered) {
    const position = anchorPosition(entry.afterItemId, positions, anchors, rows.length);
    const bucket = buckets.get(position) ?? [];

    bucket.push(entry.turn);
    buckets.set(position, bucket);
  }

  const timeline = [...(buckets.get(0) ?? [])];

  for (const [index, row] of rows.entries()) {
    timeline.push(row, ...(buckets.get(index + 1) ?? []));
  }

  return timeline;
}
