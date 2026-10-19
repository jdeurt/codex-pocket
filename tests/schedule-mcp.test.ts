import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const DAY_MS = 86_400_000;
const TOOL_COUNT = 5;

test("the bundled MCP process validates input and performs schedule CRUD over real stdio", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-mcp-"));
  const client = new Client({ name: "pocket-check", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/mcp.ts"],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      CODEX_POCKET_STATE_DIR: directory,
      POCKET_THREAD_ID: "mcp-test",
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOL_COUNT);
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.equal(result.isError, undefined, JSON.stringify(result));

      return JSON.parse((result.content as { text: string }[])[0].text) as Record<string, unknown>;
    };
    const future = new Date(Date.now() + DAY_MS)
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const created = await call("schedule_create", {
      title: "MCP check",
      body: "Read project status.",
      calendar: `DTSTART:${future}`,
    });
    const updated = await call("schedule_update", {
      id: created.id,
      changes: { title: "Updated MCP check", active: false },
      expectedRevision: created.revision,
    });
    assert.equal(updated.title, "Updated MCP check");
    const fetched = await call("schedule_get", { id: created.id });
    assert.equal(fetched.active, 0);
    assert.equal(Array.isArray(await call("schedule_list", {})), true);
    const invalid = await client.callTool({
      name: "schedule_create",
      arguments: { title: "Invalid", body: "Nothing", calendar: "DTSTART:20260230T090000Z" },
    });
    assert.equal(invalid.isError, true);
    await call("schedule_delete", { id: created.id });
    assert.deepEqual(await call("schedule_list", {}), []);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
