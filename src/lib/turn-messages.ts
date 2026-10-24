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

  const parts: string[] = [];

  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      const text = string(object(part).text);

      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n");
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
  let final: Item | undefined;
  let boundary = -1;

  for (const [index, item] of messages.entries()) {
    if (item.type === "agentMessage" && item.phase !== "commentary") {
      final = item;
    }

    if (item.type === "userMessage") {
      boundary = index;
    }
  }

  const activity: Item[] = [];
  const ids = new Set<string>();

  for (const [index, item] of messages.entries()) {
    if (!(index > boundary && item.type === "agentMessage") || item.phase === "final_answer" || item.id === final?.id) {
      continue;
    }

    activity.push(item);
    ids.add(item.id);
  }

  const entries: TurnEntry[] = [];

  let isGrouped = false;

  for (const item of messages) {
    if (!ids.has(item.id)) {
      entries.push({ kind: "message", item });
    } else if (!isGrouped) {
      entries.push({ kind: "activity", id: `activity-${turn.id}`, items: activity });
      isGrouped = true;
    }
  }

  return entries;
}

/**
Filter silent messages and select live or completed activity presentation.
@param turn - One uninterrupted segment of a normalized turn.
@param isActive - Whether progress must remain visible as it arrives.
@returns The canonical entries used by every transcript renderer.
*/
function messageEntries(turn: Turn, isActive: boolean): TurnEntry[] {
  const messages: Item[] = [];
  const entries: TurnEntry[] = [];

  for (const item of turn.items) {
    const isVisible =
      item.type === "toolTrace" ||
      (["userMessage", "agentMessage", "imageOutput"].includes(item.type) &&
        ((Array.isArray(item.images) && item.images.length > 0) ||
          (Array.isArray(item.attachments) && item.attachments.length > 0) ||
          hasMessageText(item)));

    if (!isVisible) {
      continue;
    }

    messages.push(item);
    entries.push({ kind: "message", item });
  }

  return isActive || turn.status === "interrupted" ? entries : completedEntries(turn, messages);
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
