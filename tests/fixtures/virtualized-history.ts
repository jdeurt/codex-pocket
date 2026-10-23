import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";

const USER_CADENCE = 4;
const USER_LINE_VARIANTS = 5;
const PARAGRAPH_VARIANTS = 9;
const CODE_CADENCE = 20;
const IMAGE_CADENCE = 97;

// Large enough to recycle rows; dedicated stress cases request their own larger history.
const DEFAULT_HISTORY = 320;

/**
Builds canonical synthetic history with varying text, code and image heights.
@param count - Number of message items in the synthetic turn.
@param start - Initial message index used for paging and prepend scenarios.
@returns Canonical connected snapshot for offline transcript integration flows.
*/
export function history(count = DEFAULT_HISTORY, start = 0): Snapshot {
  return {
    ...initialSnapshot,
    connection: "connected",
    threadId: "synthetic-virtualization",
    turns: [
      {
        id: "long-turn",
        status: "interrupted",
        items: Array.from({ length: count }, (_, offset) => {
          const index = start + offset;

          return {
            id: `message-${String(index)}`,
            type: index % USER_CADENCE === 0 ? "userMessage" : "agentMessage",
            content: [
              {
                type: "text",
                text: `Fixture ${String(index)}\n${"User line.\n".repeat(Math.abs(index % USER_LINE_VARIANTS))}`,
              },
            ],
            text: `Fixture ${String(index)}\n\n${"Variable height paragraph with **markdown**.\n\n".repeat(Math.abs(index % PARAGRAPH_VARIANTS))}${
              index % CODE_CADENCE === 0 ? "\n```ts\nconst fixture = true;\n```" : ""
            }`,
            ...(index % IMAGE_CADENCE === 0 && {
              images: [{ source: `/api/images?item=history-${String(index)}`, alt: `History image ${String(index)}` }],
            }),
          };
        }),
      },
    ],
  };
}
