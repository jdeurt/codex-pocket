import { type Item, object, string } from "../lib/protocol";

const names: Record<string, string> = {
  toolTrace: "Tool",
  commandExecution: "Command",
  mcpToolCall: "Tool call",
  dynamicToolCall: "Tool call",
  fileChange: "File changes",
  webSearch: "Web search",
};

// Codex 0.163 ThreadItem: MCP content uses MCP text/resource blocks;
// dynamic output uses inputText. Read display content, never arguments/_meta.
function contentText(content: unknown, type: "text" | "inputText") {
  return Array.isArray(content)
    ? content
        .map((part) => {
          const value = object(part);

          return value.type === type
            ? string(value.text)
            : type === "text" && value.type === "resource"
              ? string(object(value.resource).text)
              : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
}

export function toolTrace(item: Item): Item | undefined {
  if (!Object.hasOwn(names, item.type)) {
    return undefined;
  }

  const text =
    item.type === "mcpToolCall"
      ? [contentText(object(item.result).content, "text"), string(object(item.error).message)]
          .filter(Boolean)
          .join("\n")
      : item.type === "dynamicToolCall"
        ? contentText(item.contentItems, "inputText")
        : "";

  return {
    id: item.id,
    type: "toolTrace",
    tool: string(item.tool) || names[item.type],
    status: string(item.status),
    text: text || string(item.text) || string(item.aggregatedOutput),
  };
}
