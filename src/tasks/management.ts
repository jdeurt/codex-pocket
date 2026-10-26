import { regenerateTaskProjections } from "./projections";
import { t } from "try";
import { valueAfterCleanup } from "../lib/results";
import { TaskRepository, updateTasks } from "./repository";
import { applyTaskOperation, type TaskOperation } from "./lifecycle";
import type { Ledger } from "./model";
import { taskReviewToken } from "./review";

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
@param reviewToken - Optional inspection token that tolerates passive native bookkeeping.
@param state - Current checkpoint.
@returns Repaired state, or an error requiring a fresh review.
*/
function reviewedOperation(
  revision: number,
  operation: TaskOperation,
  reason: string,
  reviewToken: string | undefined,
  state: Ledger
) {
  const isCurrent = reviewToken ? taskReviewToken(state) === reviewToken : state.revision === revision;

  if (!isCurrent) {
    throw new Error("Task state changed after inspection; review the new revision before applying this operation.");
  }

  return applyTaskOperation(operation, reason, state);
}

/** Commit one centralized lifecycle or repair operation without changing source records.
@param parentId - Authorized parent.
@param revision - Inspected expected revision.
@param operation - Concrete reviewed operation.
@param reason - Operator explanation.
@param reviewToken - Optional inspected work-state token for native agent tool loops.
@returns Committed checkpoint.
*/
export async function changeTask(
  parentId: string,
  revision: number,
  operation: TaskOperation,
  reason: string,
  reviewToken?: string
) {
  const transition = reviewedOperation.bind(undefined, revision, operation, reason, reviewToken);
  const state = updateTasks(parentId, reason, transition);

  await regenerateTaskProjections(parentId);

  return state;
}
