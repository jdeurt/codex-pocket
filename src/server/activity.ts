import { type Item, type RpcEvent, type Snapshot, type Turn, object, string } from "../lib/protocol";

const LAST_ITEM_INDEX = -1;
const TOOL_ACTIVITIES = new Map(
  Object.entries({
    apply_patch: "Editing files",
    update_plan: "Updating plans",
    read_file: "Reading files",
    list_files: "Listing files",
    search_files: "Searching files",
    view_image: "Viewing images",
    imagegen: "Generating images",
  })
);

export function itemActivity(item: Item): string | undefined {
  switch (item.type) {
    case "userMessage": {
      return undefined;
    }

    case "commandExecution": {
      if (item.pluginId) {
        return "Using plugins";
      }

      const action = object(Array.isArray(item.commandActions) ? item.commandActions.at(LAST_ITEM_INDEX) : undefined);

      switch (action.type) {
        case "read": {
          return /(?:^|[/\\])SKILL\.md$/i.test(string(action.path)) ? "Reading skills" : "Reading files";
        }

        case "listFiles": {
          return "Listing files";
        }

        case "search": {
          return "Searching files";
        }

        default: {
          return "Running commands";
        }
      }
    }

    case "fileChange": {
      return "Editing files";
    }

    case "webSearch": {
      return object(item.action).type === "open_page" ? "Browsing pages" : "Searching sources";
    }

    case "imageView": {
      return "Viewing images";
    }

    case "imageGeneration": {
      return "Generating images";
    }

    case "mcpToolCall": {
      return "Calling tools";
    }

    case "dynamicToolCall":
    case "functionCallOutput": {
      return TOOL_ACTIVITIES.get(string(item.tool) || string(item.name)) ?? "Calling tools";
    }

    case "collabAgentToolCall": {
      return item.tool === "wait" ? "Waiting for updates" : "Coordinating agents";
    }

    case "subAgentActivity": {
      return "Coordinating agents";
    }

    case "sleep": {
      return "Waiting for updates";
    }

    case "agentMessage": {
      return "Writing responses";
    }

    case "plan": {
      return "Updating plans";
    }

    case "enteredReviewMode":
    case "exitedReviewMode": {
      return "Reviewing changes";
    }

    case "contextCompaction": {
      return "Summarizing conversations";
    }

    case "hookPrompt": {
      return "Running hooks";
    }

    default: {
      return "Considering options";
    }
  }
}

function eventActivity(event: RpcEvent, turn: Turn | undefined) {
  switch (event.method) {
    case "item/started":
    case "item/completed": {
      return itemActivity(event.params.item as Item);
    }

    case "item/agentMessage/delta": {
      return "Writing responses";
    }

    case "turn/plan/updated":
    case "item/plan/delta": {
      return "Updating plans";
    }

    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta": {
      return "Considering options";
    }

    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction": {
      const item = turn?.items.find((entry) => entry.id === event.params.itemId);

      return item ? itemActivity(item) : "Running commands";
    }

    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated": {
      return "Editing files";
    }

    case "item/mcpToolCall/progress": {
      return "Calling tools";
    }

    case "hook/started": {
      return "Running hooks";
    }

    default: {
      return undefined;
    }
  }
}

export function updateActivity(state: Snapshot, event: RpcEvent, turn: Turn | undefined) {
  if (state.activeTurnId && turn?.id === state.activeTurnId) {
    state.activity = eventActivity(event, turn) ?? state.activity;
  }
}

export function currentActivity(state: Snapshot) {
  return state.activeTurnId
    ? (state.activity ??
        state.turns
          .find((turn) => turn.id === state.activeTurnId)
          ?.items.map((item) => itemActivity(item))
          .findLast(Boolean) ??
        "Considering options")
    : undefined;
}
