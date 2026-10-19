import { type Item, type Snapshot, string } from "../lib/protocol";
import { itemImageSources, itemImageUrl } from "../lib/images";
import { currentActivity } from "./activity";
import { isRecoveryMessageId } from "./recovery";

// Only messages and explicitly projected display items leave the computer.
export function visibleSnapshot(state: Snapshot): Snapshot {
  const scheduled = new Set(Object.keys(state.scheduled ?? {}));

  return {
    ...state,
    activity: currentActivity(state),
    notices: [],
    scheduled: {},
    queue: state.queue.filter((message) => !scheduled.has(message.id) && !isRecoveryMessageId(message.id)),
    turns: state.turns.map((turn) => ({
      ...turn,
      items: turn.items.flatMap<Item>((item) => {
        if (
          item.type === "userMessage" &&
          (scheduled.has(string(item.clientId)) || isRecoveryMessageId(item.clientId))
        ) {
          return [];
        }

        const images = itemImageSources(item).map((source, index) => ({
          source: /^https?:\/\//i.test(source) ? source : itemImageUrl(item.id, index),
          alt: "Image from Pocket",
        }));

        if (["userMessage", "agentMessage"].includes(item.type)) {
          return {
            ...item,
            ...(images.length > 0 && {
              images,
              content: Array.isArray(item.content)
                ? item.content.filter((part) => (part as { type?: string }).type === "text")
                : item.content,
            }),
          };
        }

        return images.length > 0 ? { id: item.id, type: "imageOutput", images } : [];
      }),
    })),
  };
}
