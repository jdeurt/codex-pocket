import { type Snapshot, string } from "../lib/protocol";
import { type Receipt } from "./outbox";
import { VoiceHistory } from "./voice-history";
import { voiceTimeline } from "../lib/voice-timeline";
import { voiceSegmentSchema } from "../lib/voice-history";

const CONTEXT_CHARACTERS = 48_000;
const LAST = -1;

/** Attach newly saved voice conversation to the next main-agent input as historical context.
@param threadId - Parent whose voice ledger is being resumed.
@param receipts - Earlier submissions containing already delivered context boundaries.
@returns Bounded context and its durable watermark, or nothing when no new speech exists.
*/
export async function mainVoiceContext(threadId: string, receipts: Receipt[]) {
  const entries = await new VoiceHistory(threadId).read();
  const delivered = new Set(receipts.flatMap((receipt) => (receipt.voiceContext ? receipt.voiceContext.lastId : [])));
  const boundary = entries.findLastIndex((entry) => delivered.has(entry.id));
  const pending = entries.slice(boundary + 1);
  const last = pending.at(LAST);

  if (!last) {
    return;
  }

  const timeline = voiceTimeline([], pending, []);
  const ordered = timeline
    .flatMap((turn) => turn.entries)
    .flatMap((entry) => (entry.kind === "message" ? voiceSegmentSchema.parse(entry.item.voice) : []));
  const text = ordered.map(({ role, text: content }) => JSON.stringify({ role, text: content })).join("\n");
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

/** Keep internal voice context out of the visible typed user message, using durable receipt identity.
@param state - Canonical main snapshot being published.
@param receipts - Receipts retaining original user text and context provenance.
*/
export function projectVoiceContext(state: Snapshot, receipts: Receipt[]) {
  const contextual = new Map(
    receipts.filter((receipt) => receipt.voiceContext).map((receipt) => [receipt.id, receipt])
  );

  for (const turn of state.turns) {
    for (const item of turn.items) {
      const receipt = contextual.get(string(item.clientId) || item.id);

      if (receipt && item.type === "userMessage") {
        item.content = [{ type: "text", text: receipt.text }];
      }
    }
  }
}
