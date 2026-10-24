import { t } from "try";
import { log } from "./logging";

/** Format and log a tool failure without invoking a synthetic throwing operation.
@param error - Original failure from the tool's work or response encoding.
@returns The MCP error content expected by clients.
*/
export function toolError(error: unknown) {
  log().error({ error }, "pocket.tool_failed");

  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

/**
Adapt one Pocket operation to the native MCP text or error result contract.
@param operation - Concrete tool operation whose returned data is serialized once.
@returns MCP text content or the existing logged native error result.
*/
export async function toolResult(operation: () => unknown) {
  const result = await Promise.resolve(t(operation));

  if (!result.ok) {
    return toolError(result.error);
  }

  const content = t(() => JSON.stringify(result.value));

  return content.ok ? { content: [{ type: "text" as const, text: content.value }] } : toolError(content.error);
}
