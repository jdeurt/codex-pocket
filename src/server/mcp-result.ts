import { log } from "./logging";

/**
Adapt one Pocket operation to the native MCP text or error result contract.
@param operation - Concrete tool operation whose returned data is serialized once.
@returns MCP text content or the existing logged native error result.
*/
export async function toolResult(operation: () => unknown) {
  try {
    const value = await operation();

    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  } catch (error) {
    log().error({ error }, "pocket.tool_failed");

    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    };
  }
}
