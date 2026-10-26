import { createHash } from "node:crypto";
import type { Ledger, Task, TaskEvent } from "./model";

/** Keep task meaning in a review token while excluding passive membership revision increments.
@param task - Authoritative task state.
@returns Task fields that can invalidate an inspected lifecycle decision.
*/
function reviewedTask(task: Task) {
  return { ...task, revision: 0 };
}

/** Distinguish new work and delivery evidence from native bookkeeping during an agent's own tool loop.
@param event - Immutable application event.
@returns Whether arrival requires a fresh review before changing task state.
*/
function requiresReview(event: TaskEvent) {
  return (
    ["typed", "voice_request", "scheduled", "delegate_report", "recovery"].includes(event.origin) ||
    event.delivery !== "not_delivered"
  );
}

/** Retain semantic and operator decisions while excluding deterministic native correlation updates.
@param decision - Recorded assignment.
@returns Whether this decision changes the meaning of an inspected task.
*/
function isReviewedDecision(decision: Ledger["decisions"][number]) {
  return ["classification", "legacy", "correction"].includes(decision.source);
}

/** Bind a lifecycle review to work, intent, delivery and command state rather than its own native tool records.
@param state - Exact inspected parent checkpoint.
@returns Opaque deterministic token; this is concurrency control, not authorization.
*/
export function taskReviewToken(state: Ledger) {
  const reviewed = {
    parentId: state.parentId,
    mode: state.mode,
    tasks: Array.from(state.tasks, reviewedTask),
    events: state.events.filter(requiresReview.bind(undefined)),
    decisions: state.decisions.filter(isReviewedDecision.bind(undefined)),
    commands: state.commands,
    changes: state.changes,
  };

  return createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
}
