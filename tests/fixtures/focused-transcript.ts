import { type Snapshot } from "../../src/lib/protocol";

const MESSAGE_REPETITIONS = 20;
const LAST_TURN_INDEX = 39;
export const focusedSnapshot: Snapshot = {
  connection: "connected",
  threadId: "focused-scroll-fixture",
  title: "Scroll integration fixture",
  activeTurnId: "turn-39",
  activity: "Checking focus anchoring",
  turns: Array.from({ length: 40 }, (_, index) => ({
    id: `turn-${String(index)}`,
    status: index === LAST_TURN_INDEX ? "inProgress" : "completed",
    items: [
      {
        id: `message-${String(index)}`,
        type: "agentMessage",
        text: `Message ${String(index)}\n\n${"Scrollable conversation content. ".repeat(MESSAGE_REPETITIONS)}\n\n[Local reference](#message-${String(index)})`,
        phase: "final_answer",
      },
    ],
  })),
  queue: [],
  requests: [],
  notices: [],
  scheduled: {},
};
