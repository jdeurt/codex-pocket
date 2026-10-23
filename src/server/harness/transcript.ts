import { type Data, type Item, type Turn, object, string } from "../../lib/protocol";
import { type HarnessMessage } from "./types";
import { type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeToolPreview } from "../tool-preview";

export type ClaudeMessage = SessionMessage;

/**
Normalize string or native text-block content without including non-text payloads.
@param content - Native SDK or protocol content at the transcript boundary.
@returns Joined text blocks, a direct string, or an empty string.
*/
export function nativeText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return Array.isArray(content)
    ? content
        .map((part) => string(object(part).text))
        .filter(Boolean)
        .join("\n")
    : "";
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

  return Array.isArray(raw.content) ? raw.content.map((part) => object(part)) : [];
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
  parts: Data[];
  userContent: Data[];
  turn: Turn;
  calls: Map<string, Item>;
}

/**
Project one normalized SDK part into canonical message, tool or image items.
@param context - Saved message, active turn and cross-message tool-call ownership.
@param part - Normalized native content part.
@param index - Part position within the saved message.
*/
function appendPart(context: MessageContext, part: Data, index: number) {
  const { message, raw, parts, userContent, turn, calls } = context;
  const id = `${message.uuid}:${String(index)}`;

  switch (part.type) {
    case "tool_use": {
      const item: Item = {
        id,
        type: "toolTrace",
        nativeId: string(part.id),
        title: string(object(part.input).description) || string(object(part.input).name),
        tool: string(part.name),
        toolLabels: claudeToolPreview(string(part.name), object(part.input)),
        status: "running",
        text: "",
      };

      calls.set(string(part.id), item);
      turn.items.push(item);

      return;
    }

    case "tool_result": {
      const item = calls.get(string(part.tool_use_id));
      const output = nativeText(part.content);

      if (item) {
        item.status = part.is_error ? "failed" : "completed";
        item.text = output;
      } else {
        turn.items.push({
          id,
          type: "toolTrace",
          tool: "Tool result",
          status: part.is_error ? "failed" : "completed",
          text: output,
        });
      }

      if (Array.isArray(part.content)) {
        const images = part.content.map((entry) => object(entry));

        for (const [imageIndex, image] of images.entries()) {
          if (image.type === "image") {
            turn.items.push({
              id: `${id}:image:${String(imageIndex)}`,
              type: "imageOutput",
              content: [imageContent(image)],
            });
          }
        }
      }

      return;
    }

    case "text":
    case "image": {
      if (message.type === "user") {
        if (index === parts.findIndex((entry) => entry.type === "text" || entry.type === "image")) {
          turn.items.push({
            id: message.uuid,
            type: "userMessage",
            content: userContent.map((entry) => (entry.type === "image" ? imageContent(entry) : entry)),
          });
        }
      } else if (part.type === "text") {
        turn.items.push({
          id,
          type: "agentMessage",
          text: string(part.text),
          phase: raw.stop_reason === "end_turn" ? "final_answer" : "commentary",
        });
      } else {
        turn.items.push({ id, type: "imageOutput", content: [imageContent(part)] });
      }

      return;
    }
  }
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
    const userContent = parts.filter((part) => ["text", "image"].includes(string(part.type)));

    if (!turn || (message.type === "user" && userContent.length > 0)) {
      turn = { id: message.uuid, status: "inProgress", items: [] };
      turns.push(turn);
    }

    if (message.type === "system") {
      continue;
    }

    for (const [index, part] of parts.entries()) {
      appendPart({ message, raw, parts, userContent, turn, calls }, part, index);
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
  return turns.flatMap((turn) =>
    turn.items.map((item) => ({
      id: string(item.clientId) || item.id,
      role: messageRole(item),
      text: string(item.text) || nativeText(item.content),
      item,
    }))
  );
}
