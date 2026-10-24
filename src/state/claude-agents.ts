import type { SDKMessage, SDKTaskStartedMessage, SDKTaskUpdatedMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEntry } from "../lib/agents";

export type ClaudeAgentState = Record<
  string,
  Pick<AgentEntry, "name" | "status"> & {
    parentId?: SDKTaskStartedMessage["parent_task_id"];
    background?: SDKTaskStartedMessage["is_backgrounded"];
  }
>;

/**
Map SDK task-patch states into canonical read-only agent status.
@param status - Present native SDK task-patch status.
@returns Canonical status preserving running and terminal states.
*/
function patchStatus(status: NonNullable<SDKTaskUpdatedMessage["patch"]["status"]>): AgentEntry["status"] {
  if (status === "paused" || status === "pending") {
    return "unknown";
  }

  return status === "killed" ? "closed" : status;
}

/** Project SDK lifecycle events into independent scoped display state.
@param entries - Previously observed native tasks.
@param message - Original SDK message.
@returns New display state for supported lifecycle events.
*/
export function observedClaudeAgents(entries: ClaudeAgentState, message: SDKMessage): ClaudeAgentState | undefined {
  if (message.type !== "system") {
    return;
  }

  switch (message.subtype) {
    case "task_started": {
      return message.task_type === "local_agent" && !message.ambient
        ? {
            ...entries,
            [message.task_id]: {
              name: message.description,
              status: "running",
              parentId: message.parent_task_id,
              background: message.is_backgrounded,
            },
          }
        : entries;
    }

    case "task_updated": {
      const previous = entries[message.task_id];

      return Object.hasOwn(entries, message.task_id)
        ? {
            ...entries,
            [message.task_id]: {
              ...previous,
              background: message.patch.is_backgrounded ?? previous.background,
              status: message.patch.status ? patchStatus(message.patch.status) : previous.status,
            },
          }
        : entries;
    }

    case "task_notification": {
      return Object.hasOwn(entries, message.task_id)
        ? {
            ...entries,
            [message.task_id]: {
              ...entries[message.task_id],
              status: message.status === "stopped" ? "closed" : message.status,
            },
          }
        : entries;
    }

    case "background_tasks_changed": {
      const next: ClaudeAgentState = {};

      for (const [id, task] of Object.entries(entries)) {
        next[id] = task.background && task.status === "running" ? { ...task, status: "unknown" } : task;
      }

      for (const task of message.tasks) {
        if (task.task_type === "local_agent" && !task.ambient) {
          next[task.task_id] = {
            name: task.description,
            status: "running",
            parentId: task.parent_task_id,
            background: true,
          };
        }
      }

      return next;
    }
  }
}

/** Project question waiting state only for a previously discovered task.
@param entries - Previously scoped tasks.
@param id - Native task identity.
@param isWaiting - Whether the worker awaits an answer.
@returns Independent display state, or undefined for an unknown task.
*/
export function waitingClaudeAgent(
  entries: ClaudeAgentState,
  id: string,
  isWaiting: boolean
): ClaudeAgentState | undefined {
  return Object.hasOwn(entries, id)
    ? { ...entries, [id]: { ...entries[id], status: isWaiting ? "waiting" : "running" } }
    : undefined;
}
