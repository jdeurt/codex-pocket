import { type Item, type Turn, object, string } from "./protocol";

export type TurnEntry = { kind: "message"; item: Item } | { kind: "activity"; id: string; items: Item[] };

export function turnMessages(turn: Turn, active: boolean): TurnEntry[] {
  const messages = turn.items.filter((item) => {
    if (!["userMessage", "agentMessage", "imageOutput"].includes(item.type)) {
      return false;
    }

    if (
      (Array.isArray(item.images) && item.images.length > 0) ||
      (Array.isArray(item.attachments) && item.attachments.length > 0)
    ) {
      return true;
    }

    return item.type === "agentMessage"
      ? !!string(item.text).trim()
      : Array.isArray(item.content) && item.content.some((part) => !!string(object(part).text).trim());
  });

  if (active || turn.status === "interrupted") {
    return messages.map((item) => ({ kind: "message", item }));
  }

  const final = messages.findLast((item) => item.type === "agentMessage" && item.phase !== "commentary");
  // A steering message keeps earlier updates in the timeline, including after history reload.
  const boundary = messages.findLastIndex((item) => item.type === "userMessage");
  const activity = messages.filter(
    (item, index) =>
      index > boundary && item.type === "agentMessage" && item.phase !== "final_answer" && item.id !== final?.id
  );
  const ids = new Set(activity.map((item) => item.id));
  let grouped = false;

  return messages.flatMap<TurnEntry>((item) => {
    if (!ids.has(item.id)) {
      return { kind: "message", item };
    }

    if (grouped) {
      return [];
    }

    grouped = true;

    return { kind: "activity", id: `activity-${turn.id}`, items: activity };
  });
}
