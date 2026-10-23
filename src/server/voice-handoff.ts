import { type Data, object, string } from "../lib/protocol";
import type { VoiceSegment } from "../lib/voice-history";
import type { VoiceHistory } from "./voice-history";
import type { VoiceSessionOwner } from "./voice-session-owner";
import { z } from "zod";

const handoffArguments = z.object({ item_id: z.string().min(1) }).strict();
const HANDOFF_TIMEOUT_MS = 15_000;
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
@param itemIds - Immutable ordered speech identities owned by this response.
@returns The verbatim speech and durable delivery status, without replaying existing attempts.
*/
export async function handoffVoice(
  owner: VoiceSessionOwner,
  history: VoiceHistory,
  event: Data,
  sessionId: string,
  itemIds: string[]
) {
  const args = handoffArguments.parse(JSON.parse(string(event.arguments)));
  const entries = await history.read();
  const selected = itemIds.map((itemId) =>
    entries.find(
      (candidate) => candidate.nativeSessionId === sessionId && candidate.itemId === itemId && candidate.role === "user"
    )
  );
  const entry = selected[0];

  if (!entry || selected.some((item) => !item) || args.item_id !== itemIds[0]) {
    throw new Error("Voice handoff did not match its finalized turn. No request was sent. Send saved speech to retry.");
  }

  if (selected.some((item) => item?.handoff)) {
    return entry;
  }

  const handoffId = `realtime:${sessionId}:${entry.itemId}`;
  const save = async (handoff: "sending" | "sent" | "queued" | "unknown") => {
    for (const item of selected) {
      if (item) {
        await history.save({ ...item, handoff, handoffId });
      }
    }
  };

  if (selected.every((item) => !item?.text.replaceAll(/\b(?:um|uh|erm|hmm)\b|[\s.,!?]/gi, ""))) {
    throw new Error("Speech contains only filler. Finish your request before sending it.");
  }

  await save("sending");

  let result: Awaited<ReturnType<VoiceSessionOwner["handoff"]>>;
  let timer: NodeJS.Timeout | undefined;

  try {
    const dispatch = owner.handoff({
      id: handoffId,
      transcript: selected.map((item) => item?.text).join("\n"),
      source: { type: "realtime", sessionId, itemId: entry.itemId },
    });

    result = await Promise.race([
      dispatch,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Handoff acknowledgment timed out."));
        }, HANDOFF_TIMEOUT_MS);
      }),
    ]);
  } catch {
    await save("unknown");
    throw new Error("Voice handoff delivery is uncertain. Check the conversation before sending again.");
  } finally {
    clearTimeout(timer);
  }

  const status = deliveryStatus.safeParse(result.status);

  if (!status.success) {
    await save("unknown");
    throw new Error("Voice handoff returned an unknown delivery state. Check the conversation before retrying.");
  }

  await save(status.data);

  return entry;
}

/** Publish only the durable delivery result, then return it to the provider tool.
@param event - Completed provider tool call.
@param entry - Speech with the persisted delivery result.
@param itemIds - All segments covered by this receipt.
@param publish - Current browser event sink.
@param send - Current provider event sink.
*/
export function publishVoiceHandoff(
  event: Data,
  entry: VoiceSegment,
  itemIds: string[],
  publish: (event: Data) => void,
  send: (event: Data) => void
) {
  for (const itemId of itemIds) {
    publish({ type: "handoff", itemId, status: entry.handoff, handoffId: entry.handoffId });
  }

  send({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: event.call_id,
      output: JSON.stringify({ status: entry.handoff }),
    },
  });
}

/** Send explicitly selected saved speech after prior provider work settles.
@param previous - Current session work barrier.
@param owner - Main delivery owner.
@param history - Durable speech ledger.
@param id - Selected saved speech identity.
@param isIdle - Check lifecycle after waiting for prior work.
@returns Updated saved speech after a receipt-protected attempt.
*/
export async function retryVoice(
  previous: Promise<void>,
  owner: VoiceSessionOwner,
  history: VoiceHistory,
  id: string,
  isIdle: () => boolean
) {
  await previous;
  const entries = await history.read();
  const entry = entries.find((item) => item.id === id && item.role === "user");

  if (!entry?.text.trim()) {
    throw new Error("Saved speech is unavailable.");
  }

  if (!isIdle()) {
    throw new Error("Stop voice before sending saved speech.");
  }

  await handoffVoice(owner, history, { arguments: JSON.stringify({ item_id: entry.itemId }) }, entry.nativeSessionId, [
    entry.itemId,
  ]);

  return { history: await history.read() };
}

/** Keep subsequent work usable while the original caller receives the failure.
@param task - Work whose caller owns the error.
@returns A settled serialization barrier.
*/
export async function settleVoice(task: Promise<unknown>) {
  try {
    await task;
  } catch {
    /*
    The original caller reports the error.
    */
  }
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
