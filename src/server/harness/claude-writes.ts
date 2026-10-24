import { type Data, type Turn, object, string } from "../../lib/protocol";
import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const writeSchema = z.object({
  type: z.enum(["create", "update"]),
  filePath: z.string().min(1),
  staged: z.literal(false).optional(),
});
const savedWriteSchema = writeSchema.extend({ sessionId: z.string(), agentId: z.string() });

/**
Retain verified write results across the SDK's lossy saved-history boundary.
*/
export class ClaudeWrites {
  private calls = new Map<string, string | null>();

  readonly saved: Data;

  /** Restore display provenance from this child's existing private metadata.
  @param sessionId - Owned native Claude session.
  @param metadata - Persisted child metadata, absent for a new child.
  */
  constructor(
    private sessionId: string,
    metadata?: string
  ) {
    this.saved = object(object(metadata ? JSON.parse(metadata) : {}).claudeWrites);
  }

  /** Capture only successful, applied Write results with an unambiguous native call.
  @param message - Original SDK event, before structured results are discarded.
  @returns A private metadata patch, or undefined when operation evidence is absent.
  */
  observe(message: SDKMessage): Data | undefined {
    if (message.session_id !== this.sessionId) {
      return;
    }

    if (message.type === "result") {
      this.calls.clear();

      return;
    }

    if (message.type === "assistant") {
      for (const part of message.message.content) {
        if (part.type === "tool_use" && part.name === "Write") {
          this.calls.set(part.id, message.parent_tool_use_id);
        }
      }

      return;
    }

    if (message.type !== "user" || !Array.isArray(message.message.content)) {
      return;
    }

    const results = message.message.content.filter((part) => part.type === "tool_result");

    if (results.length !== 1) {
      return;
    }

    const result = results[0];
    const isOwned =
      this.calls.has(result.tool_use_id) && this.calls.get(result.tool_use_id) === message.parent_tool_use_id;

    this.calls.delete(result.tool_use_id);
    const write = writeSchema.safeParse(message.tool_use_result);

    if (!isOwned || result.is_error || !write.success) {
      return;
    }

    const saved = { ...write.data, sessionId: this.sessionId, agentId: string(object(message).agent_id) };

    this.saved[result.tool_use_id] = saved;

    return { claudeWrites: { [result.tool_use_id]: saved } };
  }
}

/** Apply durable write evidence only to matching completed calls in the owning transcript.
@param turns - Canonical saved transcript with native call identities.
@param writes - Private write metadata retained by the managed Claude child.
@param sessionId - Native session being read.
@param agentId - Native subagent identity, or an empty string for the root.
@returns The same transcript with verified display labels attached.
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
