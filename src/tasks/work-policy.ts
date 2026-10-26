import type { Ledger, Task, TaskEvent, TaskOperation } from "./model";

type WorkChange = Extract<TaskOperation, { kind: "work" }>;

/** Identify result evidence without accepting a failed operation or task bookkeeping as completed work.
@param event - Application-owned source metadata.
@returns Whether this event can support a verified-result claim.
*/
function isResult(event: TaskEvent) {
  return (
    event.origin === "delegate_report" ||
    (event.origin === "tool_result" &&
      event.isError === false &&
      !/(?:^|__)(?:pocket_task_\w+|side_pocket_\w+|pocket_send_to_chat|request_user_input)$/u.test(
        event.toolName ?? ""
      ))
  );
}

/** Require explicit completion evidence independently of the actor proposing the lifecycle change.
@param state - Current checkpoint, after membership validation by the lifecycle transition.
@param task - Task being updated.
@param operation - Explained work-state change.
@param pendingQuestions - Questions that would remain after the update.
*/
export function validateResolution(state: Ledger, task: Task, operation: WorkChange, pendingQuestions: string[]) {
  if (operation.work !== "resolved") {
    return;
  }

  if (pendingQuestions.length > 0) {
    throw new Error("Resolve or withdraw pending questions before marking task work resolved.");
  }

  if (!operation.resolution) {
    throw new Error("Resolution requires a verification statement, evidence basis and delivery requirement.");
  }

  let hasResult = false;
  let hasConfirmation = false;
  let hasDelivery = false;

  for (const event of state.events) {
    if (!operation.evidence.includes(event.id)) {
      continue;
    }

    hasResult ||= isResult(event);
    hasConfirmation ||= ["typed", "voice_request"].includes(event.origin) && event.id !== task.originalEventId;
    hasDelivery ||= event.delivery === "delivered";
  }

  const support = { result: hasResult, user_confirmation: hasConfirmation, delivered_answer: hasDelivery };
  const isSupported = support[operation.resolution.basis];

  if (!isSupported || (!hasDelivery && operation.resolution.deliveryRequired)) {
    throw new Error("Resolution lacks a successful result, later user confirmation or required delivery evidence.");
  }
}
