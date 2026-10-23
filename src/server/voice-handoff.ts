import { type Data, object, string } from "../lib/protocol";
import type { VoiceHistory } from "./voice-history";
import type { VoiceSessionOwner } from "./voice-session-owner";
import { z } from "zod";

const handoffArguments = z.object({ item_id: z.string().min(1) }).strict();
const deliveryStatus = z.enum(["queued", "sent", "unknown", "sending"]);

/**
Select function calls only after the provider confirms that the response completed.
@param event - Provider response completion; argument-done events can also belong to cancelled responses.
@returns Completed function calls, excluding interrupted and incomplete responses.
*/
export function completedHandoffs(event: Data) {
  const response = object(event.response);

  if (response.status === "failed" || response.status === "incomplete") {
    throw new Error("OpenAI voice response did not complete. No handoff was sent.");
  }

  if (response.status !== "completed" || !Array.isArray(response.output)) {
    return [];
  }

  return response.output.flatMap((entry) => {
    const item = object(entry);

    return item.type === "function_call" ? [item] : [];
  });
}

/**
Resolve a tool call against finalized speech and durably record the attempt before dispatch.
@param owner - Main-session delivery owner.
@param history - Finalized speech ledger for this conversation.
@param event - Provider function-call completion.
@param sessionId - Current voice session identity.
@param latestItemId - Most recently finalized user speech.
@returns The verbatim speech and durable delivery status, without replaying existing attempts.
*/
export async function handoffVoice(
  owner: VoiceSessionOwner,
  history: VoiceHistory,
  event: Data,
  sessionId: string,
  latestItemId?: string
) {
  const args = handoffArguments.parse(JSON.parse(string(event.arguments)));
  const entries = await history.read();
  const entry = entries.find(
    (candidate) =>
      candidate.nativeSessionId === sessionId && candidate.itemId === args.item_id && candidate.role === "user"
  );

  if (!entry || args.item_id !== latestItemId) {
    throw new Error("Voice handoff did not match the latest finalized speech. No request was sent.");
  }

  if (entry.handoff) {
    return entry;
  }

  await history.save({ ...entry, handoff: "sending" });

  let result: Awaited<ReturnType<VoiceSessionOwner["handoff"]>>;

  try {
    result = await owner.handoff({
      id: `realtime:${sessionId}:${entry.itemId}`,
      transcript: entry.text,
      source: { type: "realtime", sessionId, itemId: entry.itemId },
    });
  } catch {
    await history.save({ ...entry, handoff: "unknown" });
    throw new Error("Voice handoff delivery is uncertain. Check the conversation before sending again.");
  }

  const status = deliveryStatus.safeParse(result.status);

  if (!status.success) {
    await history.save({ ...entry, handoff: "unknown" });
    throw new Error("Voice handoff returned an unknown delivery state. Check the conversation before retrying.");
  }

  await history.save({ ...entry, handoff: status.data });

  return entry;
}

/**
Share overlapping HTTP-stop and stream-abort cleanup for the same browser token.
*/
export class VoiceSessionStop {
  private current?: { token: string; task: Promise<void> };

  /** Finish captured input before releasing its session, including failure paths.
  @param finish - Final transcription and persistence barrier.
  @param release - Cleanup bound to the captured provider connection.
  */
  private async finish(finish: () => Promise<void>, release: () => void) {
    try {
      await finish();
    } finally {
      release();
    }
  }

  /** Return the same shutdown barrier when more than one exit path stops a token.
  @param token - Browser token whose input is draining.
  @param finish - Final transcription and persistence barrier.
  @param release - Cleanup bound to the captured provider connection.
  @returns Completion of this token's existing or new shutdown.
  */
  run(token: string, finish: () => Promise<void>, release: () => void) {
    if (this.current?.token !== token) {
      this.current = { token, task: this.finish(finish, release) };
    }

    return this.current.task;
  }
}
