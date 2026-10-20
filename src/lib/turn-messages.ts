import { type Item, type Turn, object, string } from "./protocol";
import { hasMarkdownOutput } from "./markdown-content";

export type TurnEntry = { kind: "message"; item: Item } | { kind: "activity"; id: string; items: Item[] };

/**
Read display text from normalized assistant items or native content parts.
@param item - Transcript item whose text fields may be absent.
@returns The assistant text or newline-joined content text, otherwise an empty string.
*/
export function messageText(item: Item) {
  if (item.type === "agentMessage") {
    return string(item.text);
  }

  return Array.isArray(item.content)
    ? item.content
        .map((part) => string(object(part).text))
        .filter(Boolean)
        .join("\n")
    : "";
}

/**
Exclude silent source using the same Markdown renderability check as the renderer.
@param item - Candidate user or assistant message.
@returns Whether it contains displayable text under its message-specific parsing mode.
*/
export function hasMessageText(item: Item) {
  const text = messageText(item);

  return item.type === "userMessage" ? !!text.trim() : hasMarkdownOutput(text, item.type === "agentMessage");
}

/**
Group only completed post-steering progress while retaining the final answer as a row.
@param turn - Completed turn that owns the activity group ID.
@param messages - Already filtered visible messages in their native order.
@returns Messages and at most one activity group, without changing the input items.
*/
function completedEntries(turn: Turn, messages: Item[]): TurnEntry[] {
  const final = messages.findLast((item) => item.type === "agentMessage" && item.phase !== "commentary");
  // A steering message keeps earlier updates in the timeline, including after history reload.
  const boundary = messages.findLastIndex((item) => item.type === "userMessage");
  const activity = messages.filter(
    (item, index) =>
      index > boundary && item.type === "agentMessage" && item.phase !== "final_answer" && item.id !== final?.id
  );
  const ids = new Set(activity.map((item) => item.id));

  let isGrouped = false;

  return messages.flatMap<TurnEntry>((item) => {
    if (!ids.has(item.id)) {
      return { kind: "message", item };
    }

    if (isGrouped) {
      return [];
    }

    isGrouped = true;

    return { kind: "activity", id: `activity-${turn.id}`, items: activity };
  });
}

/**
Filter silent messages and select live or completed activity presentation.
@param turn - One uninterrupted segment of a normalized turn.
@param isActive - Whether progress must remain visible as it arrives.
@returns The canonical entries used by every transcript renderer.
*/
function messageEntries(turn: Turn, isActive: boolean): TurnEntry[] {
  const messages = turn.items.filter(
    (item) =>
      item.type === "toolTrace" ||
      item.type === "delegateReport" ||
      (["userMessage", "agentMessage", "imageOutput"].includes(item.type) &&
        ((Array.isArray(item.images) && item.images.length > 0) ||
          (Array.isArray(item.attachments) && item.attachments.length > 0) ||
          hasMessageText(item)))
  );

  return isActive || turn.status === "interrupted"
    ? messages.map((item) => ({ kind: "message", item }))
    : completedEntries(turn, messages);
}

/**
Build canonical message/activity entries while preserving restart boundaries.
@param turn - Normalized turn, including any persisted restart display events.
@param isActive - Whether this turn is currently running.
@returns Ordered renderable entries shared by regular and virtualized transcripts.
*/
export function turnMessages(turn: Turn, isActive: boolean): TurnEntry[] {
  const entries: TurnEntry[] = [];

  let items: Item[] = [];
  let segment = 0;

  for (const item of turn.items) {
    if (item.type === "pocketRestart") {
      // A display event is meaningful without text or media; keep it outside the empty-message filter.
      entries.push(
        ...messageEntries({ ...turn, id: segment ? `${turn.id}:${String(segment)}` : turn.id, items }, isActive),
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

  entries.push(
    ...messageEntries({ ...turn, id: segment ? `${turn.id}:${String(segment)}` : turn.id, items }, isActive)
  );

  return entries;
}
