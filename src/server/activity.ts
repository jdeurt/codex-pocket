import { type Data, type Item, type RpcEvent, type Snapshot, type Turn, object, string } from "../lib/protocol";

const LAST_ITEM_INDEX = -1;
const executions = new WeakMap<Turn, Map<string, string>>();
const nativeActivity = new WeakSet<Turn>();
const reasoning = new WeakSet<Turn>();
const TOOL_ITEMS = new Set([
  "toolTrace",
  "commandExecution",
  "fileChange",
  "webSearch",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "imageView",
  "imageGeneration",
  "subAgentActivity",
  "sleep",
]);
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

/** Select a phase from item lifecycle without treating completed tools as ongoing work.
@param item - Native item, absent on malformed notifications.
@param isStarted - Whether this is the start notification.
@param isReasoning - Whether reasoning continues alongside tools.
@returns The non-tool phase, or no change for user messages.
*/
function itemPhase(item: Item | undefined, isStarted: boolean, isReasoning: boolean) {
  if (item?.type === "userMessage") {
    return;
  }

  if (item && TOOL_ITEMS.has(item.type)) {
    return isReasoning ? "Considering options" : "";
  }

  if (isStarted && item) {
    return item.type === "reasoning" ? "Considering options" : ITEM_ACTIVITIES.get(item.type);
  }

  return "";
}

/**
Project native progress notifications into the shared activity vocabulary.
@param event - Validated native notification.
@param isReasoning - Whether native reasoning remains active alongside execution.
@returns Updated activity label or undefined when this event carries no activity change.
*/
function eventActivity(event: RpcEvent, isReasoning: boolean) {
  switch (event.method) {
    case "thread/activity/updated": {
      return typeof event.params.activity === "string" ? event.params.activity : undefined;
    }

    case "item/started":
    case "item/completed": {
      return itemPhase(event.params.item, event.method === "item/started", isReasoning);
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

    case "hook/started": {
      return "Running hooks";
    }

    default: {
      return;
    }
  }
}

/** Read executing native items when reconciling a newly hydrated turn.
@param turn - Canonical native history, replaced on reconciliation.
@returns Active calls keyed by their stable invocation identities.
*/
function restoredExecutions(turn: Turn) {
  return new Map(
    turn.items
      .filter((item) => item.source !== "pi" && TOOL_ITEMS.has(item.type))
      .filter((item) => ["running", "inProgress"].includes(string(item.status)))
      .map((item) => [item.id, itemActivity(item) ?? "Calling tools"])
  );
}

/** Normalize human activity text without touching native tool names, paths or transcript payloads.
@param label - Human description from the activity vocabulary.
@returns Description with its first character in lowercase.
*/
function activityLabel(label: string) {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Retain invocation state independently of message projection and thinking/token events.
@param turn - Exact active turn, replaced when history is reconciled.
@param event - Native lifecycle or authoritative adapter activity event.
@returns Current executing calls for this turn.
*/
function updateExecutions(turn: Turn, event: RpcEvent) {
  const calls = executions.get(turn) ?? restoredExecutions(turn);
  const item = event.params.item;

  executions.set(turn, calls);

  if (event.method === "thread/activity/updated" && Array.isArray(event.params.activeTools)) {
    nativeActivity.add(turn);
    calls.clear();

    for (const entry of event.params.activeTools) {
      const tool = object(entry);

      calls.set(string(tool.id), string(tool.activity));
    }
  } else if (item && item.source !== "pi" && TOOL_ITEMS.has(item.type)) {
    if (event.method === "item/started") {
      calls.set(item.id, itemActivity(item) ?? "Calling tools");
    } else if (event.method === "item/completed") {
      calls.delete(item.id);
    }
  }

  return calls;
}

/** Track explicit reasoning separately from concurrent tool completion.
@param turn - Current canonical turn.
@param event - Native reasoning or assistant lifecycle event.
*/
function updateReasoning(turn: Turn, event: RpcEvent) {
  if (
    event.method.startsWith("item/reasoning/") ||
    (event.method === "item/started" && event.params.item?.type === "reasoning")
  ) {
    reasoning.add(turn);
  } else if (
    event.method === "item/agentMessage/delta" ||
    (event.method === "item/completed" && event.params.item?.type === "reasoning") ||
    event.params.item?.type === "agentMessage"
  ) {
    reasoning.delete(turn);
  }
}

/** Update activity only for the current turn; terminal errors invalidate its executing calls.
@param state - Canonical mutable parent snapshot.
@param event - Validated native notification.
@param turn - Canonical turn resolved for this event.
*/
export function updateActivity(state: Snapshot, event: RpcEvent, turn: Turn | undefined) {
  if (turn && event.method === "turn/completed") {
    executions.delete(turn);
    nativeActivity.delete(turn);
    reasoning.delete(turn);
  }

  if (!state.activeTurnId || turn?.id !== state.activeTurnId) {
    return;
  }

  const calls = updateExecutions(turn, event);

  if (event.method === "error" && event.params.willRetry !== true) {
    calls.clear();
    reasoning.delete(turn);
    state.activity = "";

    return;
  }

  // Pi transcript updates describe generated calls and saved results, not execution.
  if (event.params.item?.source === "pi" || (nativeActivity.has(turn) && event.method !== "thread/activity/updated")) {
    return;
  }

  updateReasoning(turn, event);

  state.activity = eventActivity(event, reasoning.has(turn)) ?? state.activity;
}

/** Select live calls before reasoning; history reconciliation replaces transient invocation state.
@param state - Snapshot whose active turn owns the displayed activity.
@returns Comma-separated active descriptions, current reasoning, or no active status.
*/
export function currentActivity(state: Snapshot) {
  if (!state.activeTurnId || state.connection === "disconnected") {
    return;
  }

  const turn = state.turns.find((entry) => entry.id === state.activeTurnId);

  if (turn?.status !== "inProgress") {
    return;
  }

  const calls = executions.get(turn) ?? restoredExecutions(turn);

  return calls.size > 0
    ? calls
        .values()
        .map((label) => activityLabel(label))
        .toArray()
        .join(", ")
    : activityLabel(state.activity ?? "");
}
