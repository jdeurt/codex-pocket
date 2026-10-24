import { type Data, type Turn, object, string } from "../lib/protocol";
import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const writeSchema = z.object({
  type: z.enum(["create", "update"]),
  filePath: z.string().min(1),
  staged: z.literal(false).optional(),
});
const savedWriteSchema = writeSchema.extend({ sessionId: z.string(), agentId: z.string() });

export interface ClaudeWriteState {
  calls: ReadonlyMap<string, string | null>;
  saved: Data;
}

/** Restore private display evidence without retaining mutable metadata aliases.
@param metadata - Saved child metadata, absent for a new child.
@returns Initial correlation state.
*/
export function restoredClaudeWrites(metadata?: string): ClaudeWriteState {
  return { calls: new Map(), saved: object(object(metadata ? JSON.parse(metadata) : {}).claudeWrites) };
}

/** Capture verified applied Write results without changing any previous publication.
@param state - Native call correlations and durable display evidence.
@param sessionId - Owning native session.
@param message - Original SDK event before lossy history conversion.
@returns Independent correlation state and an optional durable metadata patch.
*/
export function observedClaudeWrites(
  state: ClaudeWriteState,
  sessionId: string,
  message: SDKMessage
): { state: ClaudeWriteState; patch?: Data } {
  if (message.session_id !== sessionId) {
    return { state };
  }

  if (message.type === "result") {
    return { state: { ...state, calls: new Map() } };
  }

  const calls = new Map(state.calls);

  if (message.type === "assistant") {
    for (const part of message.message.content) {
      if (part.type === "tool_use" && part.name === "Write") {
        calls.set(part.id, message.parent_tool_use_id);
      }
    }

    return { state: { ...state, calls } };
  }

  if (message.type !== "user" || !Array.isArray(message.message.content)) {
    return { state };
  }

  let result;

  for (const part of message.message.content) {
    if (part.type !== "tool_result") {
      continue;
    }

    if (result) {
      return { state };
    }

    result = part;
  }

  if (!result) {
    return { state };
  }

  const isOwned = calls.has(result.tool_use_id) && calls.get(result.tool_use_id) === message.parent_tool_use_id;

  calls.delete(result.tool_use_id);
  const write = writeSchema.safeParse(message.tool_use_result);

  if (!isOwned || result.is_error || !write.success) {
    return { state: { ...state, calls } };
  }

  const saved = { ...write.data, sessionId, agentId: string(object(message).agent_id) };

  return {
    state: { calls, saved: { ...state.saved, [result.tool_use_id]: saved } },
    patch: { claudeWrites: { [result.tool_use_id]: saved } },
  };
}

/** Apply durable write evidence only to matching completed calls in the owning transcript.
@param turns - Canonical saved transcript with native call identities.
@param writes - Private write metadata retained by the managed Claude child.
@param sessionId - Native session being read.
@param agentId - Native subagent identity, or an empty string for the root.
@returns An independent transcript with verified display labels attached.
*/
export function applyClaudeWrites(turns: Turn[], writes: Data, sessionId: string, agentId = "") {
  const next: Turn[] = [];

  for (const turn of turns) {
    const items = [];

    for (const item of turn.items) {
      const write = savedWriteSchema.safeParse(writes[string(item.nativeId)]);
      const isVerified =
        item.type === "toolTrace" &&
        item.tool === "Write" &&
        item.status === "completed" &&
        write.success &&
        write.data.sessionId === sessionId &&
        write.data.agentId === agentId;

      items.push(
        isVerified
          ? { ...item, toolLabels: [`${write.data.type === "create" ? "Created" : "Edited"} ${write.data.filePath}`] }
          : item
      );
    }

    next.push({ ...turn, items });
  }

  return next;
}
