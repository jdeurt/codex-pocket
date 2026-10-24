import { type Item, string } from "./protocol";
import { rowsForTurns, type TranscriptTurn } from "./transcript-virtualization";
import { type VoiceSegment } from "./voice-history";
import { hasMessageText } from "./turn-messages";

interface AnchoredTurn {
  id: string;
  afterItemId?: string | null;
  turn: TranscriptTurn;
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
@returns Entries with each available predecessor before its descendants.
*/
function orderedEntries(segments: AnchoredTurn[]) {
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
      current = pending.get(current.afterItemId ?? "");
    }

    ordered.push(...chain.toReversed());
  }

  return ordered;
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

/** Order speech and restart notices at durable anchors, retaining native order and receipt identity.
@param turns - Canonical main-agent rows in their authoritative order.
@param segments - Saved speech in provider order, including legacy entries without anchors.
@param queued - Receipts still owned by the main outbox.
@returns One transcript for voice and main-agent messages without text-based deduplication.
*/
export function voiceTimeline(turns: TranscriptTurn[], segments: VoiceSegment[], queued: string[]) {
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

  const anchors = new Map<string, string | null | undefined>();

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

  for (const entry of orderedEntries(anchored)) {
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
