import { isCallToolResult } from "@modelcontextprotocol/client";

/**
Decodes JSON carried by an actual MCP text tool result without trusting its application payload.
@param result - Untrusted native MCP tool response.
@returns Unknown application JSON for the caller's domain schema to validate.
*/
export function toolJson(result: unknown): unknown {
  if (!isCallToolResult(result)) {
    throw new Error("Expected an MCP tool result.");
  }

  if (result.content[0]?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }

  return JSON.parse(result.content[0].text);
}
