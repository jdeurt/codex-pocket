import { Client } from "@modelcontextprotocol/client";
import type { SpinnerLibrary } from "../../src/lib/spinner";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";

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

      return JSON.parse((result.content as { text: string }[])[0].text) as SpinnerLibrary;
    },
  };
}
