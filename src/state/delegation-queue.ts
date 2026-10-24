import type { DelegationCommand } from "../server/delegation-data";

/** Compare stable replacement identities.
@param left - First identity.
@param right - Second identity.
@returns Canonical locale ordering.
*/
function compareKeys(left: string, right: string) {
  return left.localeCompare(right);
}

/** Canonicalize superseded assignment identities for retry comparison.
@param selected - Caller-selected assignments.
@returns Deduplicated ordered identities.
*/
export function selectedCommandIds(selected: readonly string[]) {
  return [...new Set(selected)].toSorted(compareKeys);
}

/** Select the current assignment for an explicit correction.
@param commands - Durable creation order.
@param watchId - Attached native observation command.
@param sessionId - Existing native session, if any.
@returns Running work, then queued observation, then an unsent initial assignment.
*/
export function steeringTarget(
  commands: readonly DelegationCommand[],
  watchId: string | undefined,
  sessionId: string | null | undefined
) {
  let watching: DelegationCommand | undefined;
  let initial: DelegationCommand | undefined;

  for (const command of commands) {
    if (command.status === "running") {
      return command;
    }

    if (command.status !== "queued") {
      continue;
    }

    if (command.id === watchId) {
      watching ??= command;
    }

    if (command.key === "initial") {
      initial ??= command;
    }
  }

  return watching ?? (sessionId ? undefined : initial);
}

/** Select queued observation, then correction, then oldest assignment.
@param commands - Durable creation order.
@param watchId - Attached native observation command.
@returns Next eligible queued command.
*/
export function nextCommand(commands: readonly DelegationCommand[], watchId: string | undefined) {
  let first: DelegationCommand | undefined;
  let correction: DelegationCommand | undefined;

  for (const command of commands) {
    if (command.status !== "queued") {
      continue;
    }

    if (command.id === watchId) {
      return command;
    }

    first ??= command;

    if (command.mode === "steer") {
      correction ??= command;
    }
  }

  return correction ?? first;
}
