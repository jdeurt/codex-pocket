import { type Snapshot } from "../lib/protocol";
import { type VoiceSegment, voiceSegmentSchema } from "../lib/voice-history";
import { messageText, turnMessages } from "../lib/turn-messages";
import { voiceTimeline } from "../lib/voice-timeline";
import { visibleSnapshot } from "./visible-snapshot";

const CONTEXT_CHARACTERS = 48_000;

/** Prepare bounded chronological context without making a summarization model call.
@param state - Existing main Pocket conversation and pending work.
@param history - Saved voice captions from earlier calls.
@returns Explicit historical context, with a notice when older material was omitted.
*/
export function realtimeContext(state: Snapshot, history: VoiceSegment[]) {
  const visible = visibleSnapshot(state);
  const turns = visible.turns.map((turn) => ({ id: turn.id, entries: turnMessages(turn, true) }));
  const timeline = voiceTimeline(
    turns,
    history,
    visible.queue.map((entry) => entry.id)
  );
  const messages = timeline.flatMap((turn) =>
    turn.entries.flatMap((entry) => {
      if (entry.kind !== "message") {
        return [];
      }

      const { item } = entry;
      const voice = voiceSegmentSchema.safeParse(item.voice).data;
      const text = voice?.text ?? messageText(item);
      const role = voice?.role ?? (item.type === "userMessage" ? "user" : "assistant");

      return text ? JSON.stringify({ role, text }) : [];
    })
  );
  const queued = state.queue.map((entry) => ({ text: entry.text, status: entry.status }));
  const context = [...messages, `Pending main-agent requests: ${JSON.stringify(queued)}`].join("\n");
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
