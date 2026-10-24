import type { Snapshot } from "../lib/protocol";
import { visiblePreview } from "./agent-history";
import { visibleSnapshot } from "../server/visible-snapshot";

const PREVIEW_LIMIT = 180;

interface PocketWork {
  children: readonly { status: string }[];
  commands: readonly { status: string }[];
  runs: readonly { status: string }[];
  schedules: readonly { active: number }[];
  reports: number;
}

/** Select menu status without treating disconnection as completion.
@param state - Canonical parent state.
@returns Compact status label.
*/
function pocketStatus(state: Snapshot) {
  if (state.connection !== "connected") {
    return "Reconnecting…";
  }

  if (state.requests.length > 0) {
    return "Needs input";
  }

  return state.activeTurnId ? "Working" : "Ready";
}

/** Project only content allowed in the phone transcript.
@param state - Canonical immutable snapshot.
@returns Menu text and status.
*/
export function pocketPreview(state: Snapshot) {
  const items = [];

  for (const turn of visibleSnapshot(state).turns) {
    items.push(...turn.items);
  }

  const text = state.activeTurnId && state.activity ? state.activity : visiblePreview(items.toReversed());

  return { text: text.slice(0, PREVIEW_LIMIT), status: pocketStatus(state) };
}

/** Check deletion against explicit durable work observations.
@param state - Connected parent snapshot.
@param work - Collected child, schedule and report state.
*/
export function requireIdle(state: Snapshot, work: PocketWork) {
  let hasWork =
    state.activeTurnId !== undefined || state.requests.length > 0 || state.queue.length > 0 || work.reports > 0;

  for (const child of work.children) {
    hasWork ||= !["idle", "closed"].includes(child.status);
  }

  for (const command of work.commands) {
    hasWork ||= ["queued", "running", "pending", "sending", "unknown"].includes(command.status);
  }

  for (const run of work.runs) {
    hasWork ||= ["pending", "queued", "sending", "unknown"].includes(run.status);
  }

  if (hasWork) {
    throw new Error("This Pocket still has work or an unresolved delivery. Finish it before deleting.");
  }

  for (const schedule of work.schedules) {
    if (schedule.active) {
      throw new Error("This Pocket has active schedules. Disable them before deleting.");
    }
  }
}
