import { type Item, object, string } from "../lib/protocol";
import { toolPreview } from "./tool-preview";

const names = new Map(
  Object.entries({
    toolTrace: "Tool",
    commandExecution: "Command",
    mcpToolCall: "Tool call",
    dynamicToolCall: "Tool call",
    fileChange: "File changes",
    webSearch: "Web search",
  })
);

// Codex 0.163 ThreadItem: MCP content uses MCP text/resource blocks;
// dynamic output uses inputText. Read display content, never arguments/_meta.
/**
Read only native text or embedded-resource text from one untrusted content block.
@param part - External native content block normalized at this boundary.
@param type - Native protocol text discriminator for MCP or dynamic output.
@returns Display text only, excluding arguments and private metadata.
*/
function contentPartText(part: unknown, type: "text" | "inputText") {
  const value = object(part);

  if (value.type === type) {
    return string(value.text);
  }

  return type === "text" && value.type === "resource" ? string(object(value.resource).text) : "";
}

/**
Normalize native content blocks once into the existing newline-separated display text.
@param content - External native content collection, absent for output without text blocks.
@param type - Exact native MCP or dynamic text discriminator.
@returns Visible block text without protocol arguments or metadata.
*/
function contentText(content: unknown, type: "text" | "inputText") {
  return Array.isArray(content)
    ? content
        .map((part) => contentPartText(part, type))
        .filter(Boolean)
        .join("\n")
    : "";
}

/**
Read native MCP text and errors or dynamic output using their distinct protocol discriminators.
@param item - Normalized native tool output item.
@returns Existing text/error display content before the native aggregate fallback.
*/
function nativeToolText(item: Item) {
  if (item.type === "mcpToolCall") {
    return [contentText(object(item.result).content, "text"), string(object(item.error).message)]
      .filter(Boolean)
      .join("\n");
  }

  return item.type === "dynamicToolCall" ? contentText(item.contentItems, "inputText") : "";
}

/**
Project only recognized native tool output into the shared read-only trace row.
@param item - Native transcript item normalized by the shared protocol boundary.
@returns Explicit tool display item, or undefined for unrelated native item types.
*/
export function toolTrace(item: Item): Item | undefined {
  const label = names.get(item.type);

  if (!label) {
    return;
  }

  return {
    id: item.id,
    type: "toolTrace",
    tool: string(item.tool) || label,
    toolLabels: toolPreview(item),
    status: string(item.status),
    text: nativeToolText(item) || string(item.text) || string(item.aggregatedOutput),
  };
}
