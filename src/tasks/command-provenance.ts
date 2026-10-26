import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { object, string } from "../lib/protocol";
import type { Ledger } from "./model";
import { updateTasks } from "./repository";
import { piOutputOrigins } from "./adapters/pi";
import { reconcileRoutes } from "./reconciliation";
import { recordEvent } from "./transitions";
import { requestIdentity } from "./provenance";

/** Retain one native call's request origin before the delegated command can execute.
@param intent - Application-observed native call and its exact command key.
@param state - Current ledger.
@returns Durable intent, preserving conflicting origins as unresolved.
*/
function recordIntent(intent: Ledger["commandIntents"][number], state: Ledger): Ledger {
  for (const prior of state.commandIntents) {
    if (prior.callId === intent.callId) {
      return state;
    }
  }

  return { ...state, commandIntents: [...state.commandIntents, intent] };
}

/** Capture delegate-call provenance through Pi's awaited native tool hook.
@param parentId - Owning main Pocket.
@param event - Native tool call, not a user-supplied marker.
@param context - Native source reader at the execution boundary.
*/
function beforeTaskTool(parentId: string, event: ToolCallEvent, context: ExtensionContext) {
  const input = object(event.input);

  let key: string;

  if (event.toolName.endsWith("side_pocket_create")) {
    key = `create:${string(input.idempotencyKey)}`;
  } else if (event.toolName.endsWith("side_pocket_send")) {
    key = `send:${string(input.id)}:${string(input.idempotencyKey)}`;
  } else {
    return;
  }

  const entries = context.sessionManager.getBranch();
  const rootCall = event.parentToolCallId ?? event.toolCallId;
  const requestIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    for (const part of entry.message.content) {
      if (part.type !== "toolCall" || part.id !== rootCall) {
        continue;
      }

      const origin = piOutputOrigins(entries, entry);

      const origins = origin?.requestIds ?? [];

      for (const request of origins) {
        requestIds.add(request);
      }
    }
  }

  const requestId = requestIds.size === 1 ? [...requestIds][0] : null;

  updateTasks(
    parentId,
    "Record native command request origin before dispatch",
    recordIntent.bind(undefined, { callId: event.toolCallId, key, requestId, requestIds: [...requestIds] })
  );
}

/** Register the host-owned provenance hook without granting message text any authority.
@param parentId - Owning main Pocket.
@param api - Native extension API.
*/
export function taskProvenanceExtension(parentId: string, api: ExtensionAPI) {
  api.on("tool_call", beforeTaskTool.bind(undefined, parentId));
}

/** Bind a managed command to its original request, independently of semantic assignment.
@param command - Stable managed command identity.
@param key - Exact application-owned creation or follow-up key.
@param state - Current checkpoint.
@returns Command correlation, with missing or conflicting origins left unknown.
*/
function inheritCommand(command: { id: string; childId: string }, key: string, state: Ledger): Ledger {
  for (const prior of state.commands) {
    if (prior.id === command.id) {
      return state;
    }
  }

  const requests = new Set<string | null>();
  const requestIds = new Set<string>();

  for (const intent of state.commandIntents) {
    if (intent.key !== key) {
      continue;
    }

    requests.add(intent.requestId);

    for (const origin of intent.requestIds) {
      requestIds.add(origin);
    }
  }

  const requestId = requests.size === 1 ? [...requests][0] : null;

  return reconcileRoutes({
    ...state,
    commands: [...state.commands, { ...command, requestId, requestIds: [...requestIds] }],
  });
}

/** Persist a managed command's per-command origin before returning its accepted identity.
@param parentId - Parent scope verified by the delegation store.
@param childId - Reusable saved delegate identity.
@param commandId - Distinct command identity.
@param key - Exact native-call creation or follow-up key.
*/
export function inheritTaskCommand(parentId: string, childId: string, commandId: string, key: string) {
  updateTasks(
    parentId,
    "Inherit originating request per delegate command",
    inheritCommand.bind(undefined, { id: commandId, childId }, key)
  );
}

/** Record a report's application-owned command before parent receipt delivery.
@param receiptId - Stable mailbox delivery identity.
@param commandId - Recorded producing command, or null when unknown.
@param state - Current checkpoint.
@returns Reconciled report provenance.
*/
function recordReport(receiptId: string, commandId: string | null, state: Ledger) {
  return reconcileRoutes(
    recordEvent(state, {
      id: requestIdentity(receiptId),
      parentId: state.parentId,
      receiptId,
      origin: "delegate_report",
      commandId: commandId ?? undefined,
      text: "",
      contentRefs: [`delegation-mail:${receiptId}`],
      visibility: "internal",
      delivery: "not_delivered",
    })
  );
}

/** Preserve report causality without relying on its prose or the delegate's latest assignment.
@param parentId - Recorded parent.
@param receiptId - Durable mail identity.
@param commandId - Exact producing command.
*/
export function recordTaskReport(parentId: string, receiptId: string, commandId: string | null) {
  updateTasks(
    parentId,
    "Record delegate report command correlation",
    recordReport.bind(undefined, receiptId, commandId)
  );
}
