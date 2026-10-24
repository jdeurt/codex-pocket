import { type Data, type Item, type Turn, object, string } from "../lib/protocol";
import { type HarnessMessage } from "../server/harness/types";
import { type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { inputToolPreview } from "./tool-preview";

export type ClaudeMessage = SessionMessage;
const NO_CONTENT_INDEX = -1;

/**
Normalize string or native text-block content without including non-text payloads.
@param content - Native SDK or protocol content at the transcript boundary.
@returns Joined text blocks, a direct string, or an empty string.
*/
export function nativeText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  const texts: string[] = [];

  if (Array.isArray(content)) {
    for (const part of content) {
      const text = string(object(part).text);

      if (text) {
        texts.push(text);
      }
    }
  }

  return texts.join("\n");
}

/**
Normalize saved SDK message content once into canonical part objects.
@param raw - Normalized saved SDK message object.
@returns Ordered text or structured content parts.
*/
function messageParts(raw: Data): Data[] {
  if (typeof raw.content === "string") {
    return [{ type: "text", text: raw.content }];
  }

  return Array.isArray(raw.content) ? Array.from(raw.content, object) : [];
}

/**
Map canonical user and tool items to delegated history roles.
@param item - Canonical Pocket transcript item.
@returns The delegated user, tool or assistant role.
*/
function messageRole(item: Item): HarnessMessage["role"] {
  if (item.type === "userMessage") {
    return "user";
  }

  return item.type === "toolTrace" ? "tool" : "assistant";
}

/**
Project a native image source without decoding or changing its encoded bytes.
@param part - Normalized native image content part.
@returns Canonical image content with its original URL or data URL.
*/
function imageContent(part: Data) {
  const source = object(part.source);

  return {
    type: "image",
    url:
      source.type === "base64" ? `data:${string(source.media_type)};base64,${string(source.data)}` : string(source.url),
  };
}

interface MessageContext {
  message: ClaudeMessage;
  raw: Data;
  userContent: Data[];
  firstContentIndex: number;
}

/** Convert one native visible content part without changing its source.
@param part - Native content metadata.
@returns Canonical text or image content.
*/
function displayContent(part: Data) {
  return part.type === "image" ? imageContent(part) : part;
}

/** Project a native part into independent display items; correlation is explicit.
@param context - Original message and its visible user content.
@param part - Native content part.
@param index - Native part position.
@param hasToolCall - Whether a prior tool call owns this result.
@returns Newly constructed canonical items.
*/
function partItems(context: MessageContext, part: Data, index: number, hasToolCall: boolean): Item[] {
  const { message, raw, userContent, firstContentIndex } = context;
  const id = `${message.uuid}:${String(index)}`;

  if (part.type === "tool_use") {
    return [
      {
        id,
        type: "toolTrace",
        nativeId: string(part.id),
        title: string(object(part.input).description) || string(object(part.input).name),
        tool: string(part.name),
        toolLabels: inputToolPreview(string(part.name), object(part.input)),
        status: "running",
        text: "",
      },
    ];
  }

  if (part.type === "tool_result") {
    const items: Item[] = hasToolCall
      ? []
      : [
          {
            id,
            type: "toolTrace",
            tool: "Tool result",
            status: part.is_error ? "failed" : "completed",
            text: nativeText(part.content),
          },
        ];

    if (Array.isArray(part.content)) {
      for (const [imageIndex, entry] of part.content.entries()) {
        const image = object(entry);

        if (image.type === "image") {
          items.push({ id: `${id}:image:${String(imageIndex)}`, type: "imageOutput", content: [imageContent(image)] });
        }
      }
    }

    return items;
  }

  if (part.type !== "text" && part.type !== "image") {
    return [];
  }

  if (message.type === "user") {
    return index === firstContentIndex
      ? [{ id: message.uuid, type: "userMessage", content: Array.from(userContent, displayContent) }]
      : [];
  }

  return [
    part.type === "text"
      ? {
          id,
          type: "agentMessage",
          text: string(part.text),
          phase: raw.stop_reason === "end_turn" ? "final_answer" : "commentary",
        }
      : { id, type: "imageOutput", content: [imageContent(part)] },
  ];
}

// Both harnesses use Pocket's existing turns/items model. Tool calls are display data,
// never executable requests, and tool-result-only user messages are not user bubbles.
/**
Project SDK saved history while keeping tool results out of user bubbles.
@param messages - Native SDK saved-session messages in chronological order.
@returns Canonical Pocket turns with native tool and image content.
*/
export function claudeTranscript(messages: ClaudeMessage[]): Turn[] {
  const turns: Turn[] = [];

  const calls = new Map<string, Item>();

  let turn: Turn | undefined;

  for (const message of messages) {
    const raw = object(message.message);
    const parts = messageParts(raw);
    const userContent: Data[] = [];

    let firstContentIndex = NO_CONTENT_INDEX;

    for (const [index, part] of parts.entries()) {
      if (!(part.type === "text" || part.type === "image")) {
        continue;
      }

      if (firstContentIndex === NO_CONTENT_INDEX) {
        firstContentIndex = index;
      }

      userContent.push(part);
    }

    if (!turn || (message.type === "user" && userContent.length > 0)) {
      turn = { id: message.uuid, status: "inProgress", items: [] };
      turns.push(turn);
    }

    if (message.type === "system") {
      continue;
    }

    for (const [index, part] of parts.entries()) {
      const call = calls.get(string(part.tool_use_id));
      const items = partItems({ message, raw, userContent, firstContentIndex }, part, index, !!call);

      if (call && part.type === "tool_result") {
        call.status = part.is_error ? "failed" : "completed";
        call.text = nativeText(part.content);
      }

      if (part.type === "tool_use") {
        calls.set(string(part.id), items[0]);
      }

      turn.items.push(...items);
    }

    if (raw.stop_reason === "end_turn" || raw.stop_reason === "stop_sequence") {
      turn.status = "completed";
    } else if (raw.stop_reason === "max_tokens") {
      turn.status = "interrupted";
    }
  }

  return turns;
}

/**
Project canonical items into delegated history without exposing executable requests.
@param turns - Canonical chronological Pocket turns.
@returns Delegated messages retaining their original canonical items.
*/
export function harnessMessages(turns: Turn[]): HarnessMessage[] {
  const messages: HarnessMessage[] = [];

  for (const turn of turns) {
    for (const item of turn.items) {
      messages.push({
        id: string(item.clientId) || item.id,
        role: messageRole(item),
        text: string(item.text) || nativeText(item.content),
        item,
      });
    }
  }

  return messages;
}
