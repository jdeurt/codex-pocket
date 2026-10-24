import { type Item, string } from "./protocol";
import { rowsForTurns, type TranscriptTurn } from "./transcript-virtualization";
import { type VoiceSegment } from "./voice-history";
import { hasMessageText } from "./turn-messages";

/** Resolve caption anchors without recursion, preserving cycle and missing-anchor fallbacks.
@param id - Anchor to resolve.
@param positions - Canonical message positions.
@param anchors - Caption-to-anchor relationships.
@param tail - Position after the last canonical row.
@returns The insertion boundary for this caption.
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

/** Order caption dependencies before their descendants while retaining provider order.
@param segments - Saved provider-ordered captions.
@returns Captions with each available anchor preceding its dependent captions.
*/
function orderedSegments(segments: VoiceSegment[]) {
  const pending = new Map<string, VoiceSegment>();
  const ordered: VoiceSegment[] = [];

  for (const segment of segments) {
    pending.set(segment.id, segment);
  }

  for (const segment of segments) {
    const chain: VoiceSegment[] = [];

    let current: VoiceSegment | undefined = segment;

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

/** Insert saved speech at durable message anchors, retaining native order and receipt identity.
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

  for (const row of rowsForTurns(turns)) {
    const entry = row.entry;

    rows.push({ id: row.turnId, entries: [entry] });
    const items = entry.kind === "message" ? [entry.item] : entry.items;

    for (const item of items) {
      positions.set(item.id, rows.length);

      if (!(item.type === "userMessage" && hasMessageText(item))) {
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

  const buckets = new Map<number, TranscriptTurn[]>();

  for (const segment of orderedSegments(segments)) {
    if (!segment.text.trim() || (segment.role === "user" && canonical.has(captionReceipt(segment)))) {
      continue;
    }

    const position = anchorPosition(segment.afterItemId, positions, anchors, rows.length);
    const item: Item = { id: segment.id, type: "voiceMessage", voice: segment };
    const bucket = buckets.get(position) ?? [];

    bucket.push({ id: segment.id, entries: [{ kind: "message", item }] });
    buckets.set(position, bucket);
  }

  const timeline = [...(buckets.get(0) ?? [])];

  for (const [index, row] of rows.entries()) {
    timeline.push(row, ...(buckets.get(index + 1) ?? []));
  }

  return timeline;
}
