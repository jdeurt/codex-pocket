import { type Item, type Turn, object, string } from "../lib/protocol";

/** Read a text block from an unchecked native item.
@param part - Native content block.
@returns Text or an empty string.
*/
function contentText(part: unknown) {
  return string(object(part).text);
}

const MAX_PREVIEW_CHARACTERS = 1000;

/**
Read text only from native user and assistant messages, retaining the native content fallback.
@param item - Normalized native item from the requested preview page.
@returns Message text, or an empty string for non-message output.
*/
function visibleMessageText(item: Item) {
  if (!["agentMessage", "userMessage"].includes(item.type)) {
    return "";
  }

  return string(item.text) || (Array.isArray(item.content) ? Array.from(item.content, contentText).join(" ") : "");
}

/**
Select the first visible message text and bound its one-line catalog preview.
@param items - Normalized native items in the caller's requested preview order.
@returns Whitespace-normalized preview text, or an empty string when no visible message exists.
*/
export function visiblePreview(items: Item[]) {
  for (const item of items) {
    const text = visibleMessageText(item);

    if (text.trim()) {
      return text.replaceAll(/\s+/g, " ").trim().slice(0, MAX_PREVIEW_CHARACTERS);
    }
  }

  return "";
}

/** Flatten explicit turns for display without changing the source.
@param turns - Chronological native turns.
@returns Native items in their existing order.
*/
export function historyItems(turns: readonly Turn[]) {
  const items: Item[] = [];

  for (const turn of turns) {
    items.push(...turn.items);
  }

  return items;
}
