import { t } from "try";
import { valueAfterCleanup } from "../lib/results";
import { TaskRepository, updateTasks } from "./repository";
import { applyTaskOperation, type TaskOperation } from "./lifecycle";
import type { Ledger } from "./model";

/** Read an authorized parent's ledger and release its native handle.
@param parentId - Authorized parent identity.
@returns Validated checkpoint and audit history.
*/
export function readTaskLedger(parentId: string) {
  const repository = new TaskRepository(parentId);
  const result = t(repository.read.bind(repository));
  const closed = t(repository.close.bind(repository));

  return valueAfterCleanup(result, closed);
}

/** Apply an explicit reviewed repair only against the version that was inspected.
@param revision - Operator's inspected revision.
@param operation - Reviewed work, retention or membership change.
@param reason - Explanation retained in the audit ledger.
@param state - Current checkpoint.
@returns Repaired state, or an error requiring a fresh review.
*/
function reviewedOperation(revision: number, operation: TaskOperation, reason: string, state: Ledger) {
  if (state.revision !== revision) {
    throw new Error("Task state changed after inspection; review the new revision before applying this operation.");
  }

  return applyTaskOperation(operation, reason, state);
}

/** Commit one centralized lifecycle or repair operation without changing source records.
@param parentId - Authorized parent.
@param revision - Inspected expected revision.
@param operation - Concrete reviewed operation.
@param reason - Operator explanation.
@returns Committed checkpoint.
*/
export function changeTask(parentId: string, revision: number, operation: TaskOperation, reason: string) {
  return updateTasks(parentId, reason, reviewedOperation.bind(undefined, revision, operation, reason));
}
