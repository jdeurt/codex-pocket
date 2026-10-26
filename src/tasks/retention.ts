import { TASK_RETENTION_POLICY } from "./classifier-definitions";
import { planTaskContext } from "./context";
import { commandTaskIds } from "./routing";
import { applyTaskOperation } from "./lifecycle";
import type { Ledger, Task } from "./model";
import type { CommandEvidence } from "./lifecycle-evidence";

const BEFORE = -1;

/** Rank tasks by their most recent exact source association, without a nonmatch or wall-clock rule.
@param state - Current checkpoint.
@param task - Task to rank.
@returns Stable chronological source position.
*/
function taskRecency(state: Ledger, task: Task) {
  const ids = new Set<string>();

  for (const member of state.memberships) {
    if (member.taskId === task.id) {
      ids.add(member.eventId);
    }
  }

  let latest = 0;

  for (const [index, event] of state.events.entries()) {
    if ((event.nativeEntryId || event.receiptId) && ids.has(event.id)) {
      latest = index;
    }
  }

  return latest;
}

/** Order eligible terminal tasks oldest first using only recorded source order.
@param state - Current checkpoint.
@param first - First candidate.
@param second - Second candidate.
@returns Stable context-retention order.
*/
function compareRecency(state: Ledger, first: Task, second: Task) {
  if (first.id === second.id) {
    return 0;
  }

  const order = taskRecency(state, first) - taskRecency(state, second);

  return order || (first.id < second.id ? BEFORE : 1);
}

/** Require settled command facts before automatically retiring task context.
@param state - Current checkpoint.
@param commands - Application-owned command status.
@param task - Candidate terminal task.
@returns Whether no pending or uncertain assignment is connected to this task.
*/
function hasSettledCommands(state: Ledger, commands: CommandEvidence[], task: Task) {
  for (const command of state.commands) {
    if (!commandTaskIds(state, command).includes(task.id)) {
      continue;
    }

    let isSettled = false;

    for (const fact of commands) {
      if (fact.id === command.id) {
        isSettled = fact.isSettled;
      }
    }

    if (!isSettled) {
      return false;
    }
  }

  return true;
}

/** Release terminal context under an explicit capacity policy without changing task work state.
@param state - Current checkpoint.
@param commands - Current application-owned command facts.
@returns Archived old terminal tasks; open or waiting tasks are never automatically archived.
*/
export function retainTaskContext(state: Ledger, commands: CommandEvidence[]) {
  const eligible: Task[] = [];

  for (const task of state.tasks) {
    if (
      task.authority !== "proposal" &&
      task.retention === "active" &&
      ["resolved", "canceled"].includes(task.work) &&
      task.pendingQuestions.length === 0 &&
      hasSettledCommands(state, commands, task)
    ) {
      eligible.push(task);
    }
  }

  let next = state;
  let retained = eligible.length;

  const ordered = eligible.toSorted(compareRecency.bind(undefined, state));

  for (const task of ordered) {
    const plan = planTaskContext(next, TASK_RETENTION_POLICY.contextBudget);

    if (retained <= TASK_RETENTION_POLICY.recentTerminalTasks && plan.canCompact) {
      break;
    }

    next = applyTaskOperation(
      { kind: "retain", taskId: task.id, retention: "archived" },
      `${TASK_RETENTION_POLICY.version}: retire terminal context beyond the foreground capacity.`,
      next
    );
    retained--;
  }

  return next;
}
