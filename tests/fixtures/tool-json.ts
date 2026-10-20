import { isCallToolResult } from "@modelcontextprotocol/client";

export function toolJson(result: unknown): unknown {
  if (!isCallToolResult(result)) {
    throw new Error("Expected an MCP tool result.");
  }

  const content = result.content[0];

  if (content.type !== "text") {
    throw new Error("Expected a text tool result.");
  }

  return JSON.parse(content.text);
}
