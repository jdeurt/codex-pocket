import { type Snapshot, initialSnapshot } from "../../../src/lib/protocol";

const MESSAGES = 1200;
const HEIGHT_VARIANTS = 5;

export function suspensionHistory(): Snapshot {
  return {
    ...initialSnapshot,
    connection: "connected",
    turns: [
      {
        id: "parent",
        status: "interrupted",
        items: Array.from({ length: MESSAGES }, (_, index) => ({
          id: `parent-${index}`,
          type: "agentMessage",
          text: `Parent ${index}\n\n${"Variable **markdown** paragraph.\n\n".repeat(index % HEIGHT_VARIANTS)}`,
        })),
      },
    ],
  };
}
