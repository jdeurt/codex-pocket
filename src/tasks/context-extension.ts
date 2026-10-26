import type { ExtensionAPI, ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import { internalContext } from "../server/internal-context";
import { readTaskLedger } from "./management";
import { planTaskContext } from "./context";
import { TASK_RETENTION_POLICY } from "./classifier-definitions";

const CONTEXT_BUDGET = TASK_RETENTION_POLICY.contextBudget;

/** Select protected pending work at every provider call, including after native auto-compaction.
@param parentId - Owning parent.
@param event - Complete native prompt and tool declarations, preserved unchanged.
@returns Native context plus explicit ledger navigation; no source history is rewritten.
*/
function taskModelContext(parentId: string, event: ContextWithSystemEvent) {
  const state = readTaskLedger(parentId);
  const plan = planTaskContext(state, CONTEXT_BUDGET);
  const context = {
    role: "system" as const,
    timestamp: Date.now(),
    content: internalContext("task_ledger_context", plan.modelText),
  };

  return { messages: [...event.messages, context] };
}

/** Refuse native compaction when protected work exceeds the explicit context budget.
@param parentId - Owning parent.
@returns Native cancellation decision, independently of grouping or completion.
*/
function guardTaskCompaction(parentId: string) {
  const plan = planTaskContext(readTaskLedger(parentId), CONTEXT_BUDGET);

  return { cancel: !plan.canCompact };
}

/** Bind native context planning without making membership or lifecycle decisions in Pi.
@param parentId - Owning parent.
@param api - Native extension boundary.
*/
export function taskContextExtension(parentId: string, api: ExtensionAPI) {
  api.on("context_with_system", taskModelContext.bind(undefined, parentId));
  api.on("session_before_compact", guardTaskCompaction.bind(undefined, parentId));
}
