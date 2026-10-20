import { type Turn } from "../../src/lib/protocol";
import { replayToolOutputs } from "./agent-tool-output";
// OFFLINE REPLAY ONLY. These are synthetic harness wire records, not live results.

export const replayParent = "replay-parent";
export const claudeSession = "11111111-1111-4111-8111-111111111111";
const NAME_REPETITIONS = 3;
const PREVIEW_REPETITIONS = 8;
const ARCHIVE_TEXT_REPETITIONS = 200;
export const longName =
  "Researching an exceptionally long task name on a narrow phone with no horizontal scrolling ".repeat(
    NAME_REPETITIONS
  );
export const replayImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAAACXBIWXMAAAPoAAAD6AG1e1JrAAADQUlEQVR4nO3WgQnAAAwCwa76g3SHjtwxAnLgAEEf49P7EQdaweA5v4A4EKBBwIE0NAhaf4kmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAhafwgmx30GFKBBwIE0NAjmHTA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6QzA57jOgAA0CDqShQdD6Q/gBTZKAi/7jQtEAAAAASUVORK5CYII=";

/**
Builds synthetic native ancestry and status records without touching saved sessions.
@param isSettled - Whether active synthetic descendants have completed.
@param revision - Native modification marker used to exercise history refresh.
@returns Offline thread discovery records, including deliberate scope exclusions.
*/
export function replayThreads(isSettled = false, revision = 1) {
  return [
    {
      id: "native-codex",
      parentThreadId: replayParent,
      name: longName,
      status: isSettled ? { type: "idle" } : { type: "active", activeFlags: [] },
    },
    {
      id: "native-grandchild",
      parentThreadId: "native-codex",
      name: "Nested Codex research",
      status: isSettled ? { type: "idle" } : { type: "active", activeFlags: ["waitingOnApproval"] },
    },
    {
      id: "side-codex",
      parentThreadId: replayParent,
      name: "Duplicate native view of Side Pocket",
      status: { type: "idle" },
    },
    {
      id: "side-native",
      parentThreadId: "side-codex",
      name: "Codex native inside Side Pocket",
      status: { type: "notLoaded" },
    },
    {
      id: "stale-codex",
      parentThreadId: replayParent,
      name: "Unconfirmed saved activity",
      status: { type: "notLoaded" },
    },
    { id: "done-codex", parentThreadId: replayParent, name: "Finished research", status: { type: "idle" } },
    { id: "tool-codex", parentThreadId: replayParent, name: "Saved Codex tool transcript", status: { type: "idle" } },
    { id: "failed-codex", parentThreadId: replayParent, name: "Failed research", status: { type: "systemError" } },
    {
      id: "unrelated",
      parentThreadId: "another-parent",
      name: "PRIVATE_UNRELATED",
      status: { type: "active", activeFlags: [] },
    },
    {
      id: "unrelated-grandchild",
      parentThreadId: "unrelated",
      name: "PRIVATE_DESCENDANT",
      status: { type: "active", activeFlags: [] },
    },
  ].map((thread) => ({
    ...thread,
    turns: [],
    cwd: process.env.POCKET_REPLAY_DIRECTORY ?? process.cwd(),
    model: "gpt-replay",
    reasoningEffort: "high",
    source: { subAgent: { thread_spawn: { parent_thread_id: thread.parentThreadId } } },
    updatedAt: revision,
  }));
}

/**
Prepends saved native archive pages and optionally appends a changed terminal turn.
@param current - Current completed child transcript.
@param stage - Host-selected history revision.
@returns Full chronological saved history for paging and cache refresh assertions.
*/
function archivedHistory(current: Turn[], stage: string): Turn[] {
  const archived = Array.from({ length: 40 }, (_, index) => ({
    id: `archived-${String(index)}`,
    status: "completed",
    items: [
      {
        id: `archived-item-${String(index)}`,
        type: "agentMessage",
        text: `Archived research ${String(index)}. ${"Saved history. ".repeat(ARCHIVE_TEXT_REPETITIONS)}`,
        phase: "final_answer",
      },
    ],
  }));

  return [
    ...archived,
    ...current,
    ...(stage === "history-changed"
      ? [
          {
            id: "changed-turn",
            status: "completed",
            items: [
              { id: "changed-message", type: "agentMessage", text: "CHANGED_TERMINAL_HISTORY", phase: "final_answer" },
            ],
          },
        ]
      : []),
  ];
}

/**
Builds the native child transcript and its stage-dependent latest output.
@param id - Synthetic child session identity.
@param stage - Current host-selected replay stage.
@returns Canonical child history, including archive pages for the completed fixture.
*/
function ordinaryTurns(id: string, stage: string): Turn[] {
  const isActive =
    ["native-codex", "native-grandchild", "side-native", "stale-codex"].includes(id) && stage !== "settled";

  const current: Turn[] = [
    {
      id: `${id}-turn`,
      status: isActive ? "inProgress" : "completed",
      items: [
        { id: `${id}-u`, type: "userMessage", content: [{ type: "text", text: "Read the full saved conversation." }] },
        {
          id: `${id}-comment`,
          type: "agentMessage",
          text: "Earlier progress from the full transcript, absent from the completion mailbox.",
          phase: "commentary",
        },
        {
          id: `${id}-tool`,
          type: "commandExecution",
          status: "completed",
          aggregatedOutput: "REPLAY_TOOL_OUTPUT",
          secret: "PRIVATE_SESSION_SECRET",
          env: { PRIVATE_ENV: "HIDDEN_CONFIG" },
        },
        { id: `${id}-image`, type: "imageGeneration", result: replayImage, status: "completed" },
        {
          id: `${id}-a`,
          type: "agentMessage",
          text:
            stage === "updated"
              ? "LIVE_REPLAY_UPDATE"
              : `**Saved ${id} result**\n\nMarkdown and images use the same chat renderer. ${"A lengthy last visible preview for ellipsis. ".repeat(PREVIEW_REPETITIONS)}`,
          phase: "final_answer",
        },
        ...(id === "native-codex"
          ? [
              {
                id: "markdown-image",
                type: "agentMessage",
                text: "![Scoped child image][child]\n\n[child]: child-image.png",
                phase: "final_answer",
              },
            ]
          : []),
      ],
    },
  ];

  return id === "done-codex" ? archivedHistory(current, stage) : current;
}

/**
Selects synthetic parent, saved-tool or child history for one offline replay stage.
@param id - Synthetic native session identity.
@param stage - Current host-selected replay stage.
@returns Chronological canonical turns; the missing-history fixture throws.
*/
export function replayTurns(id: string, stage = "initial"): Turn[] {
  if (id === replayParent) {
    return Array.from({ length: 25 }, (_, index) => ({
      id: `parent-${String(index)}`,
      status: "completed",
      items: [
        {
          id: `parent-u-${String(index)}`,
          type: "userMessage",
          content: [{ type: "text", text: `Parent question ${String(index)}` }],
        },
        {
          id: `parent-a-${String(index)}`,
          type: "agentMessage",
          text: `Parent answer ${String(index)}. The parent conversation stays in place while viewing agents.`,
          phase: "final_answer",
        },
      ],
    }));
  }

  if (id === "missing-session") {
    throw new Error("Synthetic saved history unavailable");
  }

  if (id === "tool-codex") {
    return [
      {
        id: `${id}-turn`,
        status: "completed",
        items: [
          { id: `${id}-u`, type: "userMessage", content: [{ type: "text", text: "Read saved tool outputs." }] },
          ...replayToolOutputs(id, replayImage),
          { id: `${id}-a`, type: "agentMessage", phase: "final_answer", text: "Saved tool output transcript" },
        ],
      },
    ];
  }

  return ordinaryTurns(id, stage);
}
