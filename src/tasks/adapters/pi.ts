import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { z } from "zod";
import { object, string } from "../../lib/protocol";
import type { Ledger, TaskEvent } from "../model";
import { requestIdentity } from "../provenance";

const BINDING_TYPE = "pocket_task_input_v1";
const pendingBindingSchema = z.object({ receiptId: z.string(), hash: z.string() });

/** Hash the exact native object for durable pre-append correlation, including its native timestamp.
@param message - Original native object, not flattened input text.
@returns Exact object fingerprint.
*/
function messageHash(message: AgentMessage) {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

/** Write a durable binding intent before Pi appends its user record.
@param manager - Native persistence owner.
@param receiptId - Application-correlated accepted input identity.
@param message - Exact user-message object observed at message_end.
*/
export function preservePiBinding(manager: SessionManager, receiptId: string, message: AgentMessage) {
  manager.appendCustomEntry(BINDING_TYPE, { receiptId, hash: messageHash(message) });
}

/** Reconcile exact pre-append binding records after restart; preserve ambiguity instead of guessing.
@param entries - Exact native records with application-authored binding metadata.
@param entry - Native message awaiting correlation.
@returns One receipt identity, or undefined for missing or conflicting bindings.
*/
export function piReceiptIdentity(entries: readonly SessionEntry[], entry: SessionEntry) {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return;
  }

  const hash = messageHash(entry.message);
  const matches = new Set<string>();

  let sourceCount = 0;

  for (const candidate of entries) {
    if (candidate.type === "message" && candidate.message.role === "user" && messageHash(candidate.message) === hash) {
      sourceCount++;
    } else if (candidate.type === "custom" && candidate.customType === BINDING_TYPE) {
      const binding = pendingBindingSchema.parse(candidate.data);

      if (binding.hash === hash) {
        matches.add(binding.receiptId);
      }
    }
  }

  return sourceCount === 1 && matches.size === 1 ? [...matches][0] : undefined;
}

/** Follow native ancestry through metadata entries to the recorded preceding message.
@param entries - Exact source records.
@param parentId - Native entry's recorded parent identity.
@returns Causal native message identity, or undefined.
*/
function nativeParent(entries: readonly SessionEntry[], parentId: string | null): string | undefined {
  const seen = new Set<string>();

  let current = parentId;

  while (current && !seen.has(current)) {
    seen.add(current);
    let parent: SessionEntry | undefined;

    for (const candidate of entries) {
      if (candidate.id === current) {
        parent = candidate;
      }
    }

    if (!parent) {
      return;
    }

    if (parent.type === "message") {
      return `native:${parent.id}`;
    }

    current = parent.parentId;
  }
}

/** Project native causal relationships independently of role-shaped transport prose.
@param state - Parent's durable correlations.
@param entries - Native history used only for exact identity correlation.
@param entry - Exact committed message.
@param contentRef - Immutable exact source file.
@returns Event whose membership follows a receipt, turn or call, never the latest task.
*/
export function piTaskEvent(state: Ledger, entries: readonly SessionEntry[], entry: SessionEntry, contentRef: string) {
  if (entry.type !== "message") {
    return;
  }

  const receiptId = piReceiptIdentity(entries, entry);
  const message = object(entry.message);
  const origin: TaskEvent["origin"] = entry.message.role === "assistant" ? "assistant" : "unknown";
  const preceding = entry.message.role === "user" ? undefined : nativeParent(entries, entry.parentId);
  const event: TaskEvent = {
    id: `native:${entry.id}`,
    parentId: state.parentId,
    origin,
    nativeEntryId: entry.id,
    receiptId,
    requestId: receiptId ? requestIdentity(receiptId) : undefined,
    causedBy: receiptId ? requestIdentity(receiptId) : preceding,
    text: "",
    contentRefs: [contentRef],
    visibility: "internal",
    delivery: "not_delivered",
  };

  if (entry.message.role === "toolResult") {
    event.origin = "tool_result";
    event.callId = string(message.toolCallId);
    const owners: TaskEvent[] = [];

    for (const source of state.events) {
      if (source.callIds.includes(event.callId)) {
        owners.push(source);
      }
    }

    event.causedBy = owners.length === 1 ? owners[0].id : undefined;
  }

  const callIds: string[] = [];

  if (entry.message.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      const value = object(part);

      if (value.type === "toolCall" && typeof value.id === "string") {
        callIds.push(value.id);
      }
    }
  }

  return { ...event, callIds };
}
