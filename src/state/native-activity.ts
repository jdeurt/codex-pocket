import { type ActivityState } from "./activity";
import { type Data, type Item, type RpcEvent, type Snapshot, type Turn, object, string } from "../lib/protocol";

const LAST_ITEM_INDEX = -1;
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
function restoredExecutions(turn: Turn): [string, string][] {
  const calls: [string, string][] = [];

  for (const item of turn.items) {
    if (item.source !== "pi" && TOOL_ITEMS.has(item.type) && ["running", "inProgress"].includes(string(item.status))) {
      calls.push([item.id, itemActivity(item) ?? "Calling tools"]);
    }
  }

  return calls;
}

/** Normalize human activity text without touching native tool names, paths or transcript payloads.
@param label - Human description from the activity vocabulary.
@returns Description with its first character in lowercase.
*/
function activityLabel(label: string) {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Reconcile native execution identities without changing the previous bookkeeping.
@param previous - Explicit prior activity state.
@param event - Native lifecycle or authoritative adapter activity event.
@returns New executing call entries and authoritative-source flag.
*/
function updatedExecutions(previous: ActivityState, event: RpcEvent): ActivityState {
  const calls = new Map(previous.calls);
  const item = event.params.item;
  const hasNativeActivity =
    previous.hasNativeActivity ||
    (event.method === "thread/activity/updated" && Array.isArray(event.params.activeTools));

  if (event.method === "thread/activity/updated" && Array.isArray(event.params.activeTools)) {
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

  return { ...previous, calls: [...calls], hasNativeActivity };
}

/** Track reasoning separately from concurrent execution.
@param wasReasoning - Previous explicit reasoning phase.
@param event - Native reasoning or assistant lifecycle event.
@returns Whether reasoning remains active.
*/
function isReasoningAfter(wasReasoning: boolean, event: RpcEvent) {
  if (
    event.method.startsWith("item/reasoning/") ||
    (event.method === "item/started" && event.params.item?.type === "reasoning")
  ) {
    return true;
  }

  const hasFinished =
    event.method === "item/agentMessage/delta" ||
    (event.method === "item/completed" && event.params.item?.type === "reasoning") ||
    event.params.item?.type === "agentMessage";

  return wasReasoning && !hasFinished;
}

/** Derive initial bookkeeping from native history when no explicit state exists.
@param state - Snapshot carrying host-owned execution state.
@param turn - Active native turn.
@returns Existing state for this turn or a newly hydrated projection.
*/
function activityState(state: Snapshot, turn: Turn): ActivityState {
  return state.activityState?.turnId === turn.id
    ? state.activityState
    : {
        turnId: turn.id,
        calls: restoredExecutions(turn),
        hasNativeActivity: false,
        isReasoning: false,
      };
}

/** Update activity only for the current turn, leaving both snapshot and event unchanged.
@param state - Canonical snapshot with explicit execution bookkeeping.
@param event - Validated native notification.
@param turn - Canonical turn resolved for this event.
@returns Next snapshot and activity projection.
*/
export function updatedActivity(state: Snapshot, event: RpcEvent, turn: Turn | undefined): Snapshot {
  if (turn && event.method === "turn/completed" && state.activityState?.turnId === turn.id) {
    return { ...state, activityState: undefined };
  }

  if (!state.activeTurnId || turn?.id !== state.activeTurnId) {
    return state;
  }

  const next = updatedExecutions(activityState(state, turn), event);

  if (event.method === "error" && event.params.willRetry !== true) {
    return { ...state, activity: "", activityState: { ...next, calls: [], isReasoning: false } };
  }

  // Pi transcript records describe generated calls, not authoritative execution state.
  if (event.params.item?.source === "pi" || (next.hasNativeActivity && event.method !== "thread/activity/updated")) {
    return { ...state, activityState: next };
  }

  const isReasoning = isReasoningAfter(next.isReasoning, event);

  return {
    ...state,
    activity: eventActivity(event, isReasoning) ?? state.activity,
    activityState: { ...next, isReasoning },
  };
}

/** Select live calls before reasoning using only explicit snapshot data.
@param state - Snapshot whose active turn owns the displayed activity.
@returns Active descriptions, reasoning phase, or no active status.
*/
export function currentActivity(state: Snapshot) {
  if (!state.activeTurnId || state.connection === "disconnected") {
    return;
  }

  for (const turn of state.turns) {
    if (turn.id !== state.activeTurnId || turn.status !== "inProgress") {
      continue;
    }

    const labels: string[] = [];

    for (const [, label] of activityState(state, turn).calls) {
      labels.push(activityLabel(label));
    }

    return labels.length > 0 ? labels.join(", ") : activityLabel(state.activity ?? "");
  }
}
