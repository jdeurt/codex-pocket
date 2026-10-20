import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { spinnerLibrarySchema } from "../../src/lib/spinner";
import { toolJson } from "./tool-json";

/**
Connects a real MCP stdio client to private spinner state and normalizes its library responses.
@param directory - Private managed spinner state root.
@param overrides - Explicit fixture-only environment overrides.
@param script - Main or child MCP entry point selected by the workflow.
@returns Owned MCP client and typed spinner command operation; the caller closes the client.
*/
export async function spinnerClient(
  directory: string,
  overrides: Record<string, string> = {},
  script = "scripts/mcp.ts"
) {
  const client = new Client({ name: "spinner-flow", version: "1" });

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", script],
      cwd: process.cwd(),
      env: {
        CODEX_THREAD_ID: "",
        CODEX_POCKET_STATE_DIR: directory,
        POCKET_THREAD_ID: "spinner-fixture",
        POCKET_MAIN_THREAD_ID: "spinner-fixture",
        ...overrides,
      },
      stderr: "pipe",
    })
  );

  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });

      assert.equal(result.isError, undefined, JSON.stringify(result));

      return spinnerLibrarySchema.parse(toolJson(result));
    },
  };
}
