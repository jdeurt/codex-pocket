import { type Item, type Snapshot, string } from "../lib/protocol";
import { itemImageSources, itemImageUrl } from "../lib/images";

// Only messages and explicitly projected display items leave the computer.
export function visibleSnapshot(state: Snapshot): Snapshot {
  const scheduled = new Map(Object.entries(state.scheduled ?? {}));

  return {
    ...state,
    notices: [],
    queue: state.queue.map((message) => {
      const marker = scheduled.get(message.id);

      return marker ? { ...message, text: "", scheduled: marker } : message;
    }),
    turns: state.turns.map((turn) => ({
      ...turn,
      items: turn.items.flatMap<Item>((item) => {
        const marker = item.type === "userMessage" ? scheduled.get(string(item.clientId)) : undefined;

        if (marker) {
          return { id: item.id, clientId: item.clientId, type: "scheduledTask", ...marker };
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
