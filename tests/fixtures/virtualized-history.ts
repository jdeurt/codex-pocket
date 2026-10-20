import { type Snapshot, initialSnapshot } from "../../src/lib/protocol";

const USER_CADENCE = 4;
const USER_LINE_VARIANTS = 5;
const PARAGRAPH_VARIANTS = 9;
const CODE_CADENCE = 20;
const IMAGE_CADENCE = 97;

const LONG_HISTORY = 1200;

export function history(count = LONG_HISTORY, start = 0): Snapshot {
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
