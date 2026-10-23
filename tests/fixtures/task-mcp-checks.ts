import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { localDirectory } from "../../src/server/local-state";
import { taskSearchPage } from "../../src/server/task-index-protocol";

/** Inspect responses from the production task tool, including empty and forged-scope requests.
@param client - Connected scoped MCP client.
*/
async function checkResponses(client: Client) {
  const result = await client.callTool({ name: "pocket_task_search", arguments: { query: "late-calendar-needle" } });

  assert.equal(result.isError, undefined);
  const page = taskSearchPage.parse(result.structuredContent);
  const content = result.content.at(0);

  assert.ok(page.results.length > 0);
  assert.ok(content?.type === "text");
  assert.deepEqual(JSON.parse(content.text), page.results);
  const empty = await client.callTool({ name: "pocket_task_search", arguments: { query: "" } });
  const noMatches = taskSearchPage.parse(empty.structuredContent);

  assert.deepEqual(noMatches.results, []);
  assert.equal(noMatches.retrieval.mode, "keyword");
  const forged = await client.callTool({
    name: "pocket_task_search",
    arguments: { query: "calendar", owner: "isolated-parent" },
  });

  assert.equal(forged.isError, true);
}

/** Exercise the production MCP entry point, retaining its legacy first-content array and scoped identities.
@param owner - Parent owning the persisted native archive.
*/
export async function checkTaskMcp(owner: string) {
  const client = new Client({ name: "task-search-workflow", version: "1" });

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "scripts/mcp.ts"],
      cwd: process.cwd(),
      env: { CODEX_POCKET_STATE_DIR: localDirectory(), POCKET_THREAD_ID: owner },
      stderr: "pipe",
    })
  );

  try {
    await checkResponses(client);
  } finally {
    await client.close();
  }
}
