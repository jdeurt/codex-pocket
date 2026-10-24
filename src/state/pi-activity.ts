import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RpcEvent } from "../lib/protocol";
import { itemActivity } from "../server/activity";

/** Describe assistant streaming without interpreting generated tool arguments as execution progress.
@param event - Native Pi message event.
@returns Current message phase, or undefined for user input.
*/
function messageActivity(
  event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>
) {
  if (event.message.role !== "assistant") {
    return;
  }

  if (event.type === "message_end") {
    return "";
  }

  if (event.type === "message_update") {
    return ["thinking_start", "thinking_delta"].includes(event.assistantMessageEvent.type) ? "Considering options" : "";
  }

  return "";
}

/** Select native execution progress without changing the previous tool map.
@param previous - Current native tool activity.
@param event - Authoritative Pi execution event.
@returns New active tools and changed phase when applicable.
*/
export function piActivity(previous: ReadonlyMap<string, string>, event: AgentSessionEvent) {
  const tools = new Map(previous);

  let phase: string | undefined;

  switch (event.type) {
    case "agent_start":
    case "agent_settled": {
      tools.clear();
      phase = "";
      break;
    }

    case "tool_execution_start":
    case "tool_execution_update": {
      if (event.type === "tool_execution_start" || tools.has(event.toolCallId)) {
        const label = itemActivity({
          id: event.toolCallId,
          type: "toolTrace",
          tool: event.toolName,
          status: "running",
        });

        tools.set(event.toolCallId, label ?? "Calling tools");
        phase = "";
      }

      break;
    }

    case "tool_execution_end": {
      tools.delete(event.toolCallId);
      phase = "";
      break;
    }

    case "message_start":
    case "message_update":
    case "message_end": {
      phase = messageActivity(event);
      break;
    }

    case "turn_start":
    case "compaction_end":
    case "auto_retry_end": {
      phase = "";
      break;
    }

    case "compaction_start": {
      phase = "Summarizing conversations";
      break;
    }

    case "auto_retry_start": {
      phase = "Retrying request";
      break;
    }

    default: {
      break;
    }
  }

  return { tools, phase };
}

/** Project canonical progress only for an active submission.
@param next - Pure activity transition.
@param threadId - Owning parent identity.
@param turnId - Current submission, when present.
@returns Canonical progress event when the native event changed activity.
*/
export function piActivityEvent(
  next: ReturnType<typeof piActivity>,
  threadId: string,
  turnId: string | undefined
): RpcEvent | undefined {
  if (!turnId || next.phase === undefined) {
    return;
  }

  const activeTools = [];

  for (const [id, activity] of next.tools) {
    activeTools.push({ id, activity });
  }

  return {
    method: "thread/activity/updated",
    params: {
      threadId,
      turnId,
      activity: next.tools.size > 0 ? next.tools.values().toArray().join(", ") : next.phase,
      activeTools,
    },
  };
}
