import { type Receipt } from "./outbox";
import { VoiceHistory } from "./voice-history";
import { savedVoiceContext } from "../state/voice-context";

/** Load newly saved voice conversation for the next main-agent input.
@param threadId - Parent voice ledger.
@param receipts - Durable submissions containing delivered context boundaries.
@returns Bounded historical context and its durable watermark.
*/
export async function mainVoiceContext(threadId: string, receipts: Receipt[]) {
  return savedVoiceContext(await new VoiceHistory(threadId).read(), receipts);
}
