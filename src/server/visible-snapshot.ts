import { type Item, type Snapshot, object, string } from "../lib/protocol";
import { itemImageSources, itemImageUrl } from "../lib/images";
import { currentActivity } from "./activity";
import { delegationMessagePrefix } from "./delegation-mail";
import { isRecoveryMessageId } from "./recovery";
import { projectRestarts } from "./restart-events";
import { toolTrace } from "./tool-trace";

const internal = (id: unknown) => isRecoveryMessageId(id) || string(id).startsWith(delegationMessagePrefix);

// Only messages and explicitly projected display items leave the computer.
export function visibleSnapshot(state: Snapshot, options: { tools?: boolean } = {}): Snapshot {
  const scheduled = new Set(Object.keys(state.scheduled));

  return {
    ...state,
    activity: currentActivity(state),
    notices: [],
    scheduled: {},
    restartEvents: undefined,
    queue: state.queue.filter((message) => !scheduled.has(message.id) && !internal(message.id)),
    turns: projectRestarts(state).map((turn) => ({
      ...turn,
      items: turn.items.flatMap<Item>((item) => {
        if (item.type === "pocketRestart") {
          return { id: item.id, type: item.type };
        }

        if (item.type === "userMessage" && (scheduled.has(string(item.clientId)) || internal(item.clientId))) {
          return [];
        }

        if (item.type === "userMessage" && Array.isArray(item.attachments)) {
          const { pocketAttachmentText, ...message } = item;

          return {
            ...message,
            images: undefined,
            content: pocketAttachmentText ? [{ type: "text", text: pocketAttachmentText }] : [],
          };
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
                ? item.content.filter((part) => object(part).type === "text")
                : item.content,
            }),
          };
        }

        const tool = options.tools ? toolTrace(item) : undefined;

        if (tool) {
          return {
            ...tool,
            ...(images.length > 0 && { images }),
          };
        }

        return images.length > 0 ? { id: item.id, type: "imageOutput", images } : [];
      }),
    })),
  };
}
