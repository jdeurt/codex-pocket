import { type Data, type Item, type Turn, object, string } from "../../lib/protocol";
import { type HarnessMessage } from "./types";

export interface ClaudeMessage {
  type: string;
  uuid: string;
  message: unknown;
  parent_tool_use_id?: string | null;
  parent_agent_id?: string | null;
}

const textContent = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => string(object(part).text))
          .filter(Boolean)
          .join("\n")
      : "";

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

function appendPart({ message, raw, parts, userContent, turn, calls }: MessageContext, part: Data, index: number) {
  const id = `${message.uuid}:${String(index)}`;

  switch (part.type) {
    case "tool_use": {
      const item: Item = {
        id,
        type: "toolTrace",
        nativeId: string(part.id),
        title: string(object(part.input).description) || string(object(part.input).name),
        tool: string(part.name),
        status: "running",
        text: "",
      };

      calls.set(string(part.id), item);
      turn.items.push(item);

      return;
    }

    case "tool_result": {
      const item = calls.get(string(part.tool_use_id));
      const output = textContent(part.content);

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
        for (const [imageIndex, image] of part.content.map((entry) => object(entry)).entries()) {
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
export function claudeTranscript(messages: ClaudeMessage[]): Turn[] {
  const turns: Turn[] = [];

  let turn: Turn | undefined;

  const calls = new Map<string, Item>();

  for (const message of messages) {
    const raw = object(message.message);
    const parts =
      typeof raw.content === "string"
        ? [{ type: "text", text: raw.content }]
        : Array.isArray(raw.content)
          ? raw.content.map((part) => object(part))
          : [];
    const userContent = parts.filter((part) => ["text", "image"].includes(string(part.type)));

    if ((message.type === "user" && userContent.length > 0) || !turn) {
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

export function harnessMessages(turns: Turn[]): HarnessMessage[] {
  return turns.flatMap((turn) =>
    turn.items.map((item) => ({
      id: string(item.clientId) || item.id,
      role:
        item.type === "userMessage"
          ? ("user" as const)
          : item.type === "toolTrace"
            ? ("tool" as const)
            : ("assistant" as const),
      text: string(item.text) || textContent(item.content),
      item,
    }))
  );
}
