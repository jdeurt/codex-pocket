import { type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type RpcEvent } from "../lib/protocol";
import { itemActivity } from "./activity";

const LAST_TOOL = -1;

/** Describe assistant streaming without interpreting generated tool arguments as execution progress.
@param event - Native Pi message event.
@returns Current message phase, or undefined for user input.
*/
function messageActivity(
  event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>
) {
  if (event.message.role === "toolResult") {
    return "Considering options";
  }

  if (event.message.role !== "assistant") {
    return;
  }

  if (event.type === "message_update" && event.assistantMessageEvent.type.startsWith("thinking_")) {
    return "Considering options";
  }

  return event.message.content.some((part) => part.type === "text" && part.text.length > 0)
    ? ""
    : "Considering options";
}

/**
Track native Pi execution separately from generated tool calls and saved messages.
*/
export class PiActivity {
  private tools = new Map<string, string>();

  /** Bind progress to the existing canonical parent event stream.
  @param threadId - Owning parent identity.
  @param emit - Bridge event sink.
  */
  constructor(
    private threadId: string,
    private emit: (event: RpcEvent) => void
  ) {}

  /** Select a phase from authoritative Pi events without interpreting model output as a tool call.
  @param event - Native execution or streaming event.
  @returns Changed phase, or undefined when the event changes no work state.
  */
  private phase(event: AgentSessionEvent): string | undefined {
    switch (event.type) {
      case "agent_start":
      case "agent_settled": {
        this.tools.clear();

        return event.type === "agent_start" ? "Considering options" : "";
      }

      case "tool_execution_start":
      case "tool_execution_update": {
        const label = itemActivity({
          id: event.toolCallId,
          type: "toolTrace",
          tool: event.toolName,
          status: "running",
        });

        this.tools.set(event.toolCallId, label ?? "Calling tools");

        return "Calling tools";
      }

      case "tool_execution_end": {
        this.tools.delete(event.toolCallId);

        return "Considering options";
      }

      case "message_start":
      case "message_update":
      case "message_end": {
        return messageActivity(event);
      }

      case "turn_start":
      case "compaction_end":
      case "auto_retry_end": {
        return "Considering options";
      }

      case "compaction_start": {
        return "Summarizing conversations";
      }

      case "auto_retry_start": {
        return "Retrying request";
      }

      default: {
        return;
      }
    }
  }

  /** Publish native progress after message projection, retaining concurrent executing calls.
  @param event - Native Pi lifecycle event.
  @param turnId - Current canonical submission, absent after settlement.
  */
  accept(event: AgentSessionEvent, turnId: string | undefined) {
    const activity = this.phase(event);

    if (turnId && activity !== undefined) {
      this.emit({
        method: "thread/activity/updated",
        params: { threadId: this.threadId, turnId, activity: this.tools.values().toArray().at(LAST_TOOL) ?? activity },
      });
    }
  }
}
