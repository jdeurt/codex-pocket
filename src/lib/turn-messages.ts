import { type Item, type Turn, object, string } from "./protocol";
import { hasMarkdownOutput } from "./markdown-content";

export type TurnEntry = { kind: "message"; item: Item } | { kind: "activity"; id: string; items: Item[] };

export function messageText(item: Item) {
  return item.type === "agentMessage"
    ? string(item.text)
    : Array.isArray(item.content)
      ? item.content
          .map((part) => string(object(part).text))
          .filter(Boolean)
          .join("\n")
      : "";
}

export function hasMessageText(item: Item) {
  const text = messageText(item);

  return item.type === "userMessage" ? !!text.trim() : hasMarkdownOutput(text, item.type === "agentMessage");
}

function messageEntries(turn: Turn, active: boolean): TurnEntry[] {
  const messages = turn.items.filter(
    (item) =>
      item.type === "toolTrace" ||
      (["userMessage", "agentMessage", "imageOutput"].includes(item.type) &&
        ((Array.isArray(item.images) && item.images.length > 0) ||
          (Array.isArray(item.attachments) && item.attachments.length > 0) ||
          hasMessageText(item)))
  );

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

export function turnMessages(turn: Turn, active: boolean): TurnEntry[] {
  const entries: TurnEntry[] = [];
  let items: Item[] = [];
  let segment = 0;

  for (const item of turn.items) {
    if (item.type === "pocketRestart") {
      // A display event is meaningful without text or media; keep it outside the empty-message filter.
      entries.push(
        ...messageEntries({ ...turn, id: segment ? `${turn.id}:${String(segment)}` : turn.id, items }, active),
        {
          kind: "message",
          item,
        }
      );
      items = [];
      segment += 1;
    } else {
      items.push(item);
    }
  }

  entries.push(...messageEntries({ ...turn, id: segment ? `${turn.id}:${String(segment)}` : turn.id, items }, active));

  return entries;
}
