import {
  type SDKBackgroundTasksChangedMessage,
  type SDKMessage,
  type SDKTaskNotificationMessage,
  type SDKTaskStartedMessage,
  type SDKTaskUpdatedMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type AgentEntry } from "../../lib/agents";

type NativeAgents = Record<
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

/**
Own native Claude task display metadata without retaining task prompts.
*/
export class ClaudeAgents {
  private entries: NativeAgents = {};

  /**
Discover a nonambient local agent from its native SDK start event.
@param message - SDK task-started event.
*/
  private started(message: SDKTaskStartedMessage) {
    if (message.task_type === "local_agent" && !message.ambient) {
      this.entries[message.task_id] = {
        name: message.description,
        status: "running",
        parentId: message.parent_task_id,
        background: message.is_backgrounded,
      };
    }
  }

  /**
Apply background and status patches to an already scoped native task.
@param message - SDK task-updated event for a known task.
*/
  private updated(message: SDKTaskUpdatedMessage) {
    const status = message.patch.status;

    if (message.patch.is_backgrounded !== undefined) {
      this.entries[message.task_id].background = message.patch.is_backgrounded;
    }

    if (status) {
      this.entries[message.task_id].status = patchStatus(status);
    }
  }

  /**
Retain a known native task's terminal status after its final SDK notification.
@param message - SDK task notification for a known task.
*/
  private notified(message: SDKTaskNotificationMessage) {
    this.entries[message.task_id].status = message.status === "stopped" ? "closed" : message.status;
  }

  /**
Refresh the SDK background-agent set while retaining terminal task history.
@param message - SDK background-task replacement event.
*/
  private background(message: SDKBackgroundTasksChangedMessage) {
    for (const task of Object.values(this.entries)) {
      if (task.background && task.status === "running") {
        task.status = "unknown";
      }
    }

    for (const task of message.tasks) {
      if (task.task_type === "local_agent" && !task.ambient) {
        this.entries[task.task_id] = {
          name: task.description,
          status: "running",
          parentId: task.parent_task_id,
          background: true,
        };
      }
    }
  }

  /**
Apply supported SDK task lifecycle events and ignore unrelated message kinds.
@param message - Native SDK message from this delegated session.
@returns Scoped display metadata for a lifecycle event, or undefined otherwise.
*/
  observe(message: SDKMessage) {
    if (message.type !== "system") {
      return;
    }

    switch (message.subtype) {
      case "task_started": {
        this.started(message);
        break;
      }

      case "task_updated": {
        if (Object.hasOwn(this.entries, message.task_id)) {
          this.updated(message);
        }

        break;
      }

      case "task_notification": {
        if (Object.hasOwn(this.entries, message.task_id)) {
          this.notified(message);
        }

        break;
      }

      case "background_tasks_changed": {
        this.background(message);
        break;
      }

      default: {
        return;
      }
    }

    return this.entries;
  }

  /**
Update a known native agent's question waiting state without discovering new tasks.
@param id - Native task identity already scoped by SDK lifecycle events.
@param isWaiting - Whether the worker is awaiting a native question answer.
@returns Updated scoped metadata, or undefined for an unknown task.
*/
  waiting(id: string, isWaiting: boolean) {
    if (!Object.hasOwn(this.entries, id)) {
      return;
    }

    this.entries[id].status = isWaiting ? "waiting" : "running";

    return this.entries;
  }

  /**
Clear per-turn native task metadata before the next delegated input.
*/
  reset() {
    this.entries = {};
  }
}
