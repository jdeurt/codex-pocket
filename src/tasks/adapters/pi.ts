import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { z } from "zod";
import { object, string } from "../../lib/protocol";
import type { Ledger, TaskEvent } from "../model";
import type { TaskSource } from "../sources";
import { requestIdentity } from "../provenance";

const BINDING_TYPE = "pocket_task_input_v1";
const OUTPUT_TYPE = "pocket_task_output_v1";
const pendingBindingSchema = z.object({ receiptId: z.string(), hash: z.string(), turnId: z.string().optional() });
const outputOriginSchema = z.object({ hash: z.string(), turnId: z.string(), requestIds: z.array(z.string()) });

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
@param turnId - Application-owned run identity.
*/
export function preservePiBinding(manager: SessionManager, receiptId: string, message: AgentMessage, turnId?: string) {
  manager.appendCustomEntry(BINDING_TYPE, { receiptId, hash: messageHash(message), turnId });
}

/** Follow native metadata edges only until another message, preserving exact pre-append ownership.
@param entries - Original native records.
@param entry - Message with its recorded native parent.
@param customType - Host-owned binding record type.
@returns Exact adjacent binding data, or undefined when no application relationship exists.
*/
function nativeBindingData(entries: readonly SessionEntry[], entry: SessionEntry, customType: string) {
  const seen = new Set<string>();

  let parentId = entry.parentId;

  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    let parent: SessionEntry | undefined;

    for (const candidate of entries) {
      if (candidate.id === parentId) {
        parent = candidate;
      }
    }

    if (!parent || parent.type === "message") {
      return;
    }

    if (parent.type === "custom" && parent.customType === customType) {
      return parent.data;
    }

    parentId = parent.parentId;
  }
}

/** Resolve an exact pre-append input binding through native identities, including identical same-time messages.
@param entries - Native originals and their host-owned binding records.
@param entry - Native source awaiting correlation.
@returns Exact accepted receipt identity, or undefined when the binding is missing or conflicts with source bytes.
*/
export function piReceiptIdentity(entries: readonly SessionEntry[], entry: SessionEntry) {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return;
  }

  const data = nativeBindingData(entries, entry, BINDING_TYPE);

  if (data === undefined) {
    return;
  }

  const binding = pendingBindingSchema.parse(data);

  return binding.hash === messageHash(entry.message) ? binding.receiptId : undefined;
}

/** Recover explicit request origins recorded for one exact native assistant object.
@param entries - Original native records, including host-owned output metadata.
@param entry - Exact native assistant source.
@returns Explicit run and request identities, or undefined when provenance is missing or conflicting.
*/
export function piOutputOrigins(entries: readonly SessionEntry[], entry: SessionEntry) {
  if (entry.type !== "message" || entry.message.role !== "assistant") {
    return;
  }

  const data = nativeBindingData(entries, entry, OUTPUT_TYPE);

  if (data === undefined) {
    return;
  }

  const origin = outputOriginSchema.parse(data);

  return origin.hash === messageHash(entry.message) ? origin : undefined;
}

/** Retain native output provenance before append, using consumed inputs in the same application-owned run.
@param manager - Native persistence owner.
@param receiptId - Accepted input identity when this is a user message.
@param message - Exact message observed at the native message-end boundary.
@param turnId - Canonical application run identity.
*/
export function preservePiOrigins(
  manager: SessionManager,
  receiptId: string | undefined,
  message: AgentMessage,
  turnId: string | undefined
) {
  if (receiptId && message.role === "user") {
    preservePiBinding(manager, receiptId, message, turnId);

    return;
  }

  if (!turnId || message.role !== "assistant") {
    return;
  }

  const entries = manager.getEntries();
  const requestIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== BINDING_TYPE) {
      continue;
    }

    const binding = pendingBindingSchema.parse(entry.data);

    if (binding.turnId !== turnId) {
      continue;
    }

    for (const source of entries) {
      if (
        source.type === "message" &&
        source.message.role === "user" &&
        piReceiptIdentity(entries, source) === binding.receiptId
      ) {
        requestIds.add(requestIdentity(binding.receiptId));
      }
    }
  }

  manager.appendCustomEntry(OUTPUT_TYPE, { hash: messageHash(message), turnId, requestIds: [...requestIds] });
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
  const output = entry.message.role === "assistant" ? piOutputOrigins(entries, entry) : undefined;
  const requestIds = output?.requestIds ?? [];
  const outputRequest = requestIds.length === 1 ? requestIds[0] : undefined;
  const event: TaskEvent = {
    id: `native:${entry.id}`,
    parentId: state.parentId,
    origin,
    nativeEntryId: entry.id,
    nativeRole: entry.message.role,
    receiptId,
    requestId: receiptId ? requestIdentity(receiptId) : outputRequest,
    requestIds,
    turnId: output?.turnId,
    causedBy: receiptId ? requestIdentity(receiptId) : outputRequest,
    text: "",
    contentRefs: [contentRef],
    visibility: "internal",
    delivery: "not_delivered",
  };

  if (entry.message.role === "toolResult") {
    event.origin = "tool_result";
    event.toolName = entry.message.toolName;
    event.isError = entry.message.isError;
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

/** Reuse an exact source saved before an interrupted cursor commit.
@param entry - Original native record.
@param sources - Retained exact sources.
@param nextSequence - First unused source sequence.
@returns Existing sequence for an identical retry, or the next sequence for a new source.
*/
export function nativeSourceSequence(entry: SessionEntry, sources: TaskSource[], nextSequence: number) {
  for (const source of sources) {
    if (source.entry.id !== entry.id) {
      continue;
    }

    if (JSON.stringify(source.entry.original) !== JSON.stringify(entry)) {
      throw new Error("Native source identity has conflicting originals; inspect retained evidence.");
    }

    return source.entry.sequence;
  }

  return nextSequence;
}
