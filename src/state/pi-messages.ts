import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Item, type Turn, type RpcEvent, object, string } from "../lib/protocol";
import { findById, upsertById } from "../lib/identity";
import { nativeText } from "./harness-transcript";
import { inputToolPreview, toolPreview } from "./tool-preview";

/** Project native tool images without modifying provider content.
@param message - Completed tool message.
@returns Source-preserving image descriptors.
*/
function toolImages(message: Extract<AgentMessage, { role: "toolResult" }>) {
  const images = [];

  for (const part of message.content) {
    if (part.type === "image") {
      images.push({ source: `data:${part.mimeType};base64,${part.data}`, alt: message.toolName });
    }
  }

  return images;
}

/** Project Pi messages into Pocket's existing phone transcript without changing their source payload.
@param message - Native Pi message or final tool result.
@param turn - Owning Pocket submission lifecycle.
@param userId - Durable client receipt identity for an accepted user input.
@returns Ordered canonical items retaining the original Pi message and tool-call identities.
*/
export function piItems(message: AgentMessage, turn: Turn, userId?: string): Item[] {
  const raw = object(message);
  const id = `${turn.id}:${String(raw.timestamp)}:${string(raw.role)}`;

  if (message.role === "user") {
    return [
      {
        id: userId ?? id,
        clientId: userId,
        type: "userMessage",
        content: message.content,
        source: "pi",
        original: message,
      },
    ];
  }

  if (message.role === "toolResult") {
    const call = findById(turn.items, message.toolCallId);

    return [
      {
        id: message.toolCallId,
        type: "toolTrace",
        tool: message.toolName,
        toolLabels: call ? toolPreview(call) : [],
        status: message.isError ? "failed" : "completed",
        text: nativeText(message.content),
        source: "pi",
        original: message,
        images: toolImages(message),
      },
    ];
  }

  if (message.role !== "assistant") {
    return [];
  }

  const items: Item[] = [];

  for (const [index, part] of message.content.entries()) {
    if (part.type === "text") {
      items.push({
        id: `${id}:${String(index)}`,
        type: "agentMessage",
        text: part.text,
        source: "pi",
        original: message,
      });
    } else if (part.type === "toolCall") {
      items.push({
        id: part.id,
        type: "toolTrace",
        tool: part.name,
        toolLabels: inputToolPreview(part.name, object(part.arguments)),
        title: part.name,
        input: part.arguments,
        text: "",
        status: "running",
        source: "pi",
        original: part,
      });
    }
  }

  return items;
}

/** Replace streamed items and describe their canonical events.
@param turn - Original immutable turn.
@param items - Native item updates.
@param threadId - Owning parent identity.
@returns New turn and ordered events for the runtime to publish.
*/
export function piItemUpdate(turn: Turn, items: Item[], threadId: string) {
  let next = turn.items;

  const events: RpcEvent[] = [];

  for (const item of items) {
    next = upsertById(next, item);
    events.push({ method: "item/completed", params: { threadId, turnId: turn.id, item } });
  }

  return { turn: { ...turn, items: next }, events };
}

/** Find the turn that already owns an accepted user receipt.
@param turns - Canonical chronological turns.
@param receiptId - Accepted native receipt identity.
@param active - Fallback current turn.
@returns Original owning turn or the active submission.
*/
export function receiptTurn(turns: Turn[], receiptId: string | undefined, active: Turn) {
  for (const turn of turns) {
    if (receiptId && findById(turn.items, receiptId)) {
      return turn;
    }
  }

  return active;
}

/** Select a terminal Pi status from explicit native outcome information.
@param turn - Current canonical turn.
@param messages - Current native session messages.
@param error - Native run failure, if present.
@returns Independent terminal turn.
*/
export function completedPiTurn(turn: Turn, messages: AgentMessage[], error?: unknown): Turn {
  let stopReason: string | undefined;

  for (const message of messages) {
    if (message.role === "assistant") {
      stopReason = message.stopReason;
    }
  }

  const isInterrupted = turn.status === "interrupted" || stopReason === "aborted";
  const isFailed = !isInterrupted && (error !== undefined || stopReason === "error");

  const status = isFailed ? "failed" : "completed";

  return {
    ...turn,
    status: isInterrupted ? "interrupted" : status,
    error: isFailed ? { message: "Pi could not complete this turn. Inspect provider access and host logs." } : null,
  };
}

/** Make a provider-accepted correction visible before its tool finishes.
@param turn - Current original turn, including updates received during acceptance.
@param receiptId - Durable receipt identity.
@param text - Exact accepted input.
@param threadId - Owning parent identity.
@returns Updated turn and publication events.
*/
export function acceptedPiInput(turn: Turn, receiptId: string, text: string, threadId: string) {
  return piItemUpdate(
    turn,
    [{ id: receiptId, clientId: receiptId, type: "userMessage", source: "pi", content: [{ type: "text", text }] }],
    threadId
  );
}
