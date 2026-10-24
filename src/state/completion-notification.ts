import { hasMessageText, messageText, turnMessages } from "../lib/turn-messages";
import type { NotificationPayload } from "../lib/notification-payload";
import type { Turn, Item } from "../lib/protocol";
import { visibleTurn } from "./visible-snapshot";

// RFC 8291 permits 3993 plaintext bytes in a 4096-byte encrypted payload.
const MAX_PAYLOAD_BYTES = 3993;

/** Project one complete Unicode grapheme.
@param part - Unicode segmentation result.
@returns The original grapheme text.
*/
function graphemeText(part: Intl.SegmentData) {
  return part.segment;
}

/**
Select a rendered final assistant reply or visible image output for completion delivery.
@param threadId - Owning parent identity included only in the existing notification tag.
@param turn - Completed native turn whose final assistant output is selected.
@returns Shared completion payload, or undefined when the turn ended without a visible reply.
*/
export function completionNotification(threadId: string, turn: Turn): NotificationPayload | undefined {
  let finalReply: Item | undefined;
  let unphasedReply: Item | undefined;
  let hasImage = false;

  const entries = turnMessages(visibleTurn({}, turn), false);

  for (const entry of entries) {
    if (entry.kind !== "message") {
      continue;
    }

    const item = entry.item;

    hasImage ||= item.type === "imageOutput";

    if (item.type === "agentMessage") {
      if (item.phase === "final_answer") {
        finalReply = item;
      } else if (!item.phase) {
        unphasedReply = item;
      }
    }
  }

  const reply = finalReply ?? unphasedReply;

  if (!reply && !hasImage) {
    return;
  }

  return {
    title: "Pocket",
    body: reply && hasMessageText(reply) ? messageText(reply).trim() : "Pocket sent an image or attachment.",
    tag: `${threadId}:${turn.id}`,
    url: "/",
  };
}

/**
Bound serialized notification bytes while preserving complete native Unicode graphemes.
@param notification - Normalized completion notification whose full JSON exceeds the encrypted payload limit.
@returns JSON payload whose actual UTF-8 size fits the existing plaintext limit.
*/
function boundedPayload(notification: NotificationPayload) {
  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(notification.body),
    graphemeText
  );

  let start = 0;
  let end = characters.length;

  // Measure serialized UTF-8, including escapes, and preserve whole Unicode characters.
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    const candidate = JSON.stringify({ ...notification, body: characters.slice(0, middle).join("") });

    if (Buffer.byteLength(candidate) <= MAX_PAYLOAD_BYTES) {
      start = middle;
    } else {
      end = middle - 1;
    }
  }

  return JSON.stringify({ ...notification, body: characters.slice(0, start).join("") });
}

/**
Preserve full visible replies that fit and bound only oversized serialized completion notifications.
@param notification - Eligible visible completion selected before receipt claiming.
@returns Shared notification JSON within the existing encrypted-push byte budget.
*/
export function completionPayload(notification: NotificationPayload) {
  const payload = JSON.stringify(notification);

  return Buffer.byteLength(payload) <= MAX_PAYLOAD_BYTES ? payload : boundedPayload(notification);
}
