import type { Item, Turn } from "./protocol";

export type TurnEntry = { kind: "message"; item: Item } | { kind: "activity"; id: string; items: Item[] };

export function turnMessages(turn: Turn, active: boolean): TurnEntry[] {
  const messages = turn.items.filter((item) => ["userMessage", "agentMessage", "imageOutput"].includes(item.type));

  if (active) {
    return messages.map((item) => ({ kind: "message", item }));
  }

  const final = messages.findLast((item) => item.type === "agentMessage" && item.phase !== "commentary");
  const activity = messages.filter(
    (item) => item.type === "agentMessage" && item.phase !== "final_answer" && item.id !== final?.id
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
