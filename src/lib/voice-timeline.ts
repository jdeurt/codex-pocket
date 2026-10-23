import { type Item, string } from "./protocol";
import { type TranscriptTurn } from "./transcript-virtualization";
import { type VoiceSegment } from "./voice-history";
import { hasMessageText } from "./turn-messages";

const MISSING_ITEM = -1;

/** Insert saved speech at durable message anchors, retaining native order and receipt identity.
@param turns - Canonical main-agent rows in their authoritative order.
@param segments - Saved speech in provider order, including legacy entries without anchors.
@param queued - Receipts still owned by the main outbox.
@returns One transcript for voice and main-agent messages without text-based deduplication.
*/
export function voiceTimeline(turns: TranscriptTurn[], segments: VoiceSegment[], queued: string[]) {
  const canonical = new Set(queued);
  const positions = new Map<string, number>();
  const rows = turns.flatMap((turn) => turn.entries.map((entry) => ({ id: turn.id, entries: [entry] })));

  for (const [index, row] of rows.entries()) {
    const entry = row.entries[0];
    const items = entry.kind === "message" ? [entry.item] : entry.items;

    for (const item of items) {
      positions.set(item.id, index + 1);

      if (!(item.type === "userMessage" && hasMessageText(item))) {
        continue;
      }

      canonical.add(item.id);
      canonical.add(string(item.clientId));
    }
  }

  const anchors = new Map(segments.map((segment) => [segment.id, segment.afterItemId]));

  for (const segment of segments) {
    const receipt = segment.handoffId ?? `realtime:${segment.nativeSessionId}:${segment.itemId}`;
    const receiptPosition = rows.findIndex((row) => {
      const entry = row.entries[0];

      return (
        entry.kind === "message" &&
        (entry.item.id === receipt || entry.item.clientId === receipt) &&
        hasMessageText(entry.item)
      );
    });

    if (receiptPosition !== MISSING_ITEM) {
      positions.set(segment.id, receiptPosition + 1);
    }
  }

  const locate = (id: string | null | undefined, seen = new Set<string>()): number => {
    if (id === null) {
      return 0;
    }

    if (!id || seen.has(id)) {
      return rows.length;
    }

    if (positions.has(id)) {
      return positions.get(id) ?? rows.length;
    }

    seen.add(id);

    return locate(anchors.get(id), seen);
  };
  const buckets = new Map<number, TranscriptTurn[]>();
  const ordered: VoiceSegment[] = [];
  const pending = new Map(segments.map((segment) => [segment.id, segment]));
  const append = (segment: VoiceSegment) => {
    if (!pending.delete(segment.id)) {
      return;
    }

    const previous = pending.get(segment.afterItemId ?? "");

    if (previous) {
      append(previous);
    }

    ordered.push(segment);
  };

  for (const segment of segments) {
    append(segment);
  }

  for (const segment of ordered) {
    const receipt = segment.handoffId ?? `realtime:${segment.nativeSessionId}:${segment.itemId}`;

    if (!segment.text.trim() || (segment.role === "user" && canonical.has(receipt))) {
      continue;
    }

    // Old histories have no ordering evidence. Keep their saved order at the tail.
    const position = locate(segment.afterItemId);
    const item: Item = {
      id: segment.id,
      type: "voiceMessage",
      voice: segment,
    };
    const bucket = buckets.get(position) ?? [];

    bucket.push({ id: segment.id, entries: [{ kind: "message", item }] });
    buckets.set(position, bucket);
  }

  return [...(buckets.get(0) ?? []), ...rows.flatMap((row, index) => [row, ...(buckets.get(index + 1) ?? [])])];
}
