import { type Data, type Item, type RpcEvent, type Snapshot, type Turn, object, string } from "../lib/protocol";

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
    bash: "Running commands",
    read: "Reading files",
    write: "Editing files",
    edit: "Editing files",
    grep: "Searching files",
    find: "Searching files",
    ls: "Listing files",
    pocket_session_settings: "Updating session",
  })
);

const ITEM_ACTIVITIES = new Map(
  Object.entries({
    fileChange: "Editing files",
    imageView: "Viewing images",
    imageGeneration: "Generating images",
    mcpToolCall: "Calling tools",
    subAgentActivity: "Coordinating agents",
    sleep: "Waiting for updates",
    agentMessage: "",
    plan: "Updating plans",
    enteredReviewMode: "Reviewing changes",
    exitedReviewMode: "Reviewing changes",
    contextCompaction: "Summarizing conversations",
    hookPrompt: "Running hooks",
  })
);

/**
Describe a native command action without interpreting command text as a protocol.
@param action - Native command action normalized by the shared object boundary.
@returns Existing file, skill, search or command activity label.
*/
function commandActionActivity(action: Data) {
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

/**
Prefer the native plugin label before inspecting a command's final structured action.
@param item - Normalized native command-execution item.
@returns Existing plugin or command-action activity label.
*/
function commandActivity(item: Item) {
  if (item.pluginId) {
    return "Using plugins";
  }

  return commandActionActivity(
    object(Array.isArray(item.commandActions) ? item.commandActions.at(LAST_ITEM_INDEX) : undefined)
  );
}

/**
Project one normalized native item into the existing activity vocabulary.
@param item - Native transcript item, including silent user and assistant message distinctions.
@returns Activity label, an intentional blank assistant label, or undefined for user messages.
*/
export function itemActivity(item: Item): string | undefined {
  switch (item.type) {
    case "toolTrace": {
      const tool = string(item.tool).split("__").at(LAST_ITEM_INDEX) ?? "";

      return item.status === "running"
        ? (TOOL_ACTIVITIES.get(tool.toLowerCase()) ?? "Calling tools")
        : "Considering options";
    }

    case "userMessage": {
      return;
    }

    case "commandExecution": {
      return commandActivity(item);
    }

    case "webSearch": {
      return object(item.action).type === "open_page" ? "Browsing pages" : "Searching sources";
    }

    case "dynamicToolCall":
    case "functionCallOutput": {
      return TOOL_ACTIVITIES.get(string(item.tool) || string(item.name)) ?? "Calling tools";
    }

    case "collabAgentToolCall": {
      return item.tool === "wait" ? "Waiting for updates" : "Coordinating agents";
    }

    default: {
      return ITEM_ACTIVITIES.get(item.type) ?? "Considering options";
    }
  }
}

/**
Project native progress notifications into the shared activity vocabulary.
@param event - Validated native notification.
@param turn - Canonical turn whose current item can clarify command progress.
@returns Updated activity label or undefined when this event carries no activity change.
*/
function eventActivity(event: RpcEvent, turn: Turn | undefined) {
  switch (event.method) {
    case "thread/activity/updated": {
      return typeof event.params.activity === "string" ? event.params.activity : undefined;
    }

    case "item/started":
    case "item/completed": {
      return event.params.item ? itemActivity(event.params.item) : "";
    }

    case "item/agentMessage/delta": {
      return "";
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
      return;
    }
  }
}

/**
Update activity only when a native event belongs to the current active turn.
@param state - Canonical mutable parent snapshot.
@param event - Validated native notification.
@param turn - Canonical turn resolved for this event.
*/
export function updateActivity(state: Snapshot, event: RpcEvent, turn: Turn | undefined) {
  if (state.activeTurnId && turn?.id === state.activeTurnId) {
    state.activity = eventActivity(event, turn) ?? state.activity;
  }
}

/**
Select current activity from native progress state or the last active-turn item.
@param state - Snapshot whose active turn owns the displayed activity.
@returns Existing activity label, or undefined when no native turn is active.
*/
export function currentActivity(state: Snapshot) {
  return state.activeTurnId
    ? (state.activity ??
        state.turns
          .find((turn) => turn.id === state.activeTurnId)
          ?.items.map((item) => itemActivity(item))
          .findLast((label) => label !== undefined) ??
        "Considering options")
    : undefined;
}
