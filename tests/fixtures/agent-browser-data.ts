// OFFLINE REPLAY ONLY. These are synthetic harness wire records, not live results.
import type { RestartEvent, Turn } from "../../src/lib/protocol";

export const replayParent = "replay-parent";
const PARENT_TURNS = 25;
// The real Bridge records a typed restart after hydrating this saved parent.
// Assert its boundary rather than seeding a second display event into history.
export const replayRestartBoundary: RestartEvent["after"] = {
  turnId: `parent-${PARENT_TURNS - 1}`,
  itemId: `parent-a-${PARENT_TURNS - 1}`,
};
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
export function replayThreads(settled = false, revision = 1) {
  return [
    {
      id: "native-codex",
      parentThreadId: replayParent,
      name: longName,
      status: settled ? { type: "idle" } : { type: "active", activeFlags: [] },
    },
    {
      id: "native-grandchild",
      parentThreadId: "native-codex",
      name: "Nested Codex research",
      status: settled ? { type: "idle" } : { type: "active", activeFlags: ["waitingOnApproval"] },
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
export function replayTurns(id: string, stage = "initial"): Turn[] {
  if (id === replayParent) {
    return Array.from({ length: PARENT_TURNS }, (_, index) => ({
      id: `parent-${index}`,
      status: "completed",
      items: [
        { id: `parent-u-${index}`, type: "userMessage", content: [{ type: "text", text: `Parent question ${index}` }] },
        {
          id: `parent-a-${index}`,
          type: "agentMessage",
          text: `Parent answer ${index}. The parent conversation stays in place while viewing agents.`,
          phase: "final_answer",
        },
      ],
    }));
  }

  if (id === "missing-session") {
    throw new Error("Synthetic saved history unavailable");
  }

  const active =
    ["native-codex", "native-grandchild", "side-native", "stale-codex"].includes(id) && stage !== "settled";

  const current: Turn[] = [
    {
      id: `${id}-turn`,
      status: active ? "inProgress" : "completed",
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

  if (id !== "done-codex") {
    return current;
  }

  const archived = Array.from({ length: 40 }, (_, index) => ({
    id: `archived-${index}`,
    status: "completed",
    items: [
      {
        id: `archived-item-${index}`,
        type: "agentMessage",
        text: `Archived research ${index}. ${"Saved history. ".repeat(ARCHIVE_TEXT_REPETITIONS)}`,
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
