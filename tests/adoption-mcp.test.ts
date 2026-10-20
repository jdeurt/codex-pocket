import { codexOwner, ownedTurn } from "./fixtures/codex-owner";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { sidePocketSchema } from "../src/server/delegation-data";
import test from "node:test";
import { toolJson } from "./fixtures/tool-json";

/**
Verify native tool registration, durable adoption receipts and retry behavior through the real SDK.
@param client - Parent MCP client.
@param fixture - Existing shared owner and private store.
@param threadId - Original native thread to adopt.
*/
async function checkMcpAdoption(client: Client, fixture: Awaited<ReturnType<typeof codexOwner>>, threadId: string) {
  const listed = await client.callTool({ name: "side_pocket_sessions", arguments: { socketPath: fixture.socketPath } });
  const input = { threadId, title: "Hooked session", idempotencyKey: "hook", socketPath: fixture.socketPath };
  const adopted = await client.callTool({ name: "side_pocket_adopt", arguments: input });
  const child = sidePocketSchema.parse(toolJson(adopted));
  const retry = await client.callTool({ name: "side_pocket_adopt", arguments: input });
  const forged = await client.callTool({ name: "side_pocket_adopt", arguments: { ...input, parentId: "elsewhere" } });

  assert.equal(listed.isError, undefined);
  assert.match(JSON.stringify(toolJson(listed)), new RegExp(threadId, "u"));
  assert.equal(adopted.isError, undefined);
  assert.equal(child.parentId, "parent");
  assert.equal(child.sessionId, threadId);
  assert.equal(sidePocketSchema.parse(toolJson(retry)).id, child.id);
  assert.equal(forged.isError, true);
  assert.equal(fixture.store.list("parent").length, 1);
  assert.equal(fixture.calls.filter((call) => call.method === "turn/start").length, 1);
}

await test("parent MCP discovers and adopts live sessions without inherited CODEX_THREAD_ID or a local binary", async (t) => {
  const fixture = await codexOwner(t);
  const { thread } = await ownedTurn(fixture);
  const client = new Client({ name: "adoption-check", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/mcp.ts"],
    cwd: process.cwd(),
    env: {
      CODEX_THREAD_ID: "",
      POCKET_THREAD_ID: "parent",
      CODEX_POCKET_STATE_DIR: fixture.directory,
      POCKET_CODEX_BINARY: "/absent-codex",
    },
    stderr: "pipe",
  });

  t.after(() => client.close());
  await client.connect(transport);
  await checkMcpAdoption(client, fixture, thread.id);
});
