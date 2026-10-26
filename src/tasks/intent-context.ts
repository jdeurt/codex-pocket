import { latestDecision } from "./reconciliation";
import type { Ledger } from "./model";

export interface TaskRequestUpdate {
  eventId: string;
  text: string;
  references: string[];
}

/** Preserve successive current instructions and explicit per-task spans separately from original intent.
@param state - Parent checkpoint.
@param taskId - Exact task.
@param omittedEventId - Optional original event already represented by immutable task intent.
@returns Current request updates in recorded order, without importing frozen historical instructions.
*/
export function taskRequestUpdates(state: Ledger, taskId: string, omittedEventId?: string) {
  const updates: TaskRequestUpdate[] = [];

  for (const event of state.events) {
    if (
      event.id === omittedEventId ||
      !["typed", "voice_request", "scheduled"].includes(event.origin) ||
      latestDecision(state, event.id)?.source === "legacy"
    ) {
      continue;
    }

    const spans: string[] = [];

    let isMember = false;
    let hasWholeEvent = false;

    for (const member of state.memberships) {
      if (member.eventId !== event.id || member.taskId !== taskId) {
        continue;
      }

      isMember = true;

      if (member.span) {
        spans.push(event.text.slice(member.span.start, member.span.end));
      } else {
        hasWholeEvent = true;
      }
    }

    if (isMember) {
      updates.push({
        eventId: event.id,
        text: hasWholeEvent ? event.text : spans.join("\n"),
        references: event.references,
      });
    }
  }

  return updates;
}
