import { type Turn } from "../lib/protocol";
import { findById } from "../lib/identity";
import { piItemUpdate } from "./pi-messages";

/** Build an explicitly authored main-Pocket chat message with native tool retry identity.
@param turn - Current canonical parent turn.
@param threadId - Owning main Pocket.
@param callId - Native Pi invocation identity.
@param text - Complete report or Markdown links chosen by the main agent.
@returns Canonical publication, or no update for an identical tool retry.
*/
export function piChatMessage(turn: Turn, threadId: string, callId: string, text: string) {
  if (!text.trim()) {
    throw new Error("A chat message must contain text.");
  }

  const id = `pi-chat:${callId}`;
  const existing = findById(turn.items, id);

  if (existing) {
    if (existing.text !== text || existing.delivery !== "chat") {
      throw new Error("This chat delivery identity already belongs to another message.");
    }

    return;
  }

  return piItemUpdate(
    turn,
    [{ id, type: "agentMessage", source: "pi", delivery: "chat", phase: "final_answer", text }],
    threadId
  );
}
