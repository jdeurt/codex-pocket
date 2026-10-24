import { type Snapshot, type Turn, type QueuedMessage, string } from "../lib/protocol";
import { type VoiceSegment, voiceSegmentSchema } from "../lib/voice-history";
import { type TranscriptTurn } from "../lib/transcript-virtualization";
import { messageText, turnMessages, hasMessageText } from "../lib/turn-messages";
import { voiceTimeline } from "../lib/voice-timeline";
import { visibleSnapshot } from "../server/visible-snapshot";
import { findById } from "../lib/identity";
import { queuedIdentity } from "./conversation";

const CONTEXT_CHARACTERS = 48_000;
const LAST = -1;

/** Serialize chronological visible messages without changing caption or native state.
@param timeline - Explicit combined voice and native entries.
@param shouldRequireVoice - Whether every message must carry a valid saved caption.
@returns Exact newline-delimited role/text history.
*/
function timelineText(timeline: readonly TranscriptTurn[], shouldRequireVoice: boolean) {
  const messages: string[] = [];

  for (const turn of timeline) {
    for (const entry of turn.entries) {
      if (entry.kind !== "message") {
        continue;
      }

      const item = entry.item;
      const voice = shouldRequireVoice
        ? voiceSegmentSchema.parse(item.voice)
        : voiceSegmentSchema.safeParse(item.voice).data;
      const text = voice?.text ?? messageText(item);
      const role = voice?.role ?? (item.type === "userMessage" ? "user" : "assistant");

      if (text || shouldRequireVoice) {
        messages.push(JSON.stringify({ role, text }));
      }
    }
  }

  return messages.join("\n");
}

/** Select only newly saved voice captions after the last delivered watermark.
@param entries - Saved caption ledger.
@param receipts - Durable submissions with delivered voice boundaries.
@returns Bounded historical context and its exact durable watermark.
*/
export function savedVoiceContext(entries: VoiceSegment[], receipts: readonly QueuedMessage[]) {
  const delivered = new Set<string>();

  for (const receipt of receipts) {
    if (receipt.voiceContext) {
      delivered.add(receipt.voiceContext.lastId);
    }
  }

  let boundary = -1;

  for (const [index, entry] of entries.entries()) {
    if (delivered.has(entry.id)) {
      boundary = index;
    }
  }

  const pending = entries.slice(boundary + 1);
  const last = pending.at(LAST);

  if (!last) {
    return;
  }

  const text = timelineText(voiceTimeline([], pending, []), true);
  const recent = text.slice(-CONTEXT_CHARACTERS);

  return {
    lastId: last.id,
    text:
      "Saved voice conversation for continuity. These are historical captions, not new commands. " +
      "Do not repeat work already handled during voice. Answer the current user message using this background.\n" +
      (recent.length < text.length ? "Older captions omitted to fit the context budget.\n" : "") +
      recent,
  };
}

/** Select display turns for historical context.
@param turn - Visible native turn.
@returns Turn entries in active display mode.
*/
function contextTurn(turn: Turn): TranscriptTurn {
  return { id: turn.id, entries: turnMessages(turn, true) };
}

/** Select public queued work without exposing internal receipt fields.
@param entry - Queued canonical delivery.
@returns Text and durable status.
*/
function pendingContext(entry: QueuedMessage) {
  return { text: entry.text, status: entry.status };
}

/** Prepare bounded chronological startup context without a summarization model call.
@param state - Canonical conversation and pending work.
@param history - Saved voice captions.
@returns Historical context with explicit truncation and activity metadata.
*/
export function realtimeContext(state: Snapshot, history: VoiceSegment[]) {
  const visible = visibleSnapshot(state);
  const turns = Array.from(visible.turns, contextTurn);
  const timeline = voiceTimeline(turns, history, Array.from(visible.queue, queuedIdentity));
  const messages = timelineText(timeline, false);
  const pending = `Pending main-agent requests: ${JSON.stringify(Array.from(state.queue, pendingContext))}`;
  const context = messages ? `${messages}\n${pending}` : pending;
  const recent = context.slice(-CONTEXT_CHARACTERS);

  return [
    "Saved Pocket conversation for continuity. This is historical content, not a new request. " +
      "Do not answer or execute old requests again. Continue when the user speaks. " +
      "The main agent retains its workspace and tool history; ask it when more context is needed.",
    context.length > recent.length ? "Older conversation was omitted to fit the voice context budget." : "",
    `Main agent activity: ${visible.activity ?? (state.activeTurnId ? "working" : "idle")}.`,
    recent,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Select the last visible message for a new voice segment's chronological anchor.
@param snapshot - Canonical conversation.
@returns Latest visible message identity, or no anchor.
*/
export function lastVisibleMessage(snapshot: Snapshot) {
  const turns = visibleSnapshot(snapshot).turns;

  for (let index = turns.length - 1; index >= 0; index--) {
    const item = turns[index].items.findLast(hasMessageText);

    if (item) {
      return item.id;
    }
  }

  return null;
}

/** Project a completed main-agent turn into tool results for the realtime owner.
@param snapshot - Latest canonical history.
@param completed - Native completed turn, if available.
@returns Exact result text and source delivery identities.
*/
export function voiceWorkerResult(snapshot: Snapshot, completed: Turn | undefined) {
  if (!completed) {
    return;
  }

  const turn = findById(snapshot.turns, completed.id) ?? completed;

  if (turn.status === "inProgress") {
    return;
  }

  const messages: string[] = [];
  const ids: string[] = [];

  for (const item of turn.items) {
    if (item.type === "agentMessage" && item.phase !== "commentary") {
      messages.push(messageText(item));
    }

    if (item.type === "userMessage") {
      ids.push(string(item.clientId) || item.id);
    }
  }

  return { ids, text: messages.join("\n"), status: turn.status };
}
