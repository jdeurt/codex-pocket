import { log } from "./logging";

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
