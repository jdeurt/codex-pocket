import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { DelegationStore } from "../src/server/delegations";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

await test("a child MCP exposes only message_parent and routes content to its recorded parent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-child-mcp-"));
  const store = new DelegationStore(directory);
  const owner = "parent-chat";
  store.saveParent(owner, { cwd: "/tmp", policy: { sandbox: "danger-full-access", approval: "never" } });
  const child = store.create(owner, { title: "Check", body: "Check messaging", idempotencyKey: "check" });
  const command = store.claim(owner, child.id);
  assert.ok(command);
  const client = new Client({ name: "child-check", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/side-pocket-mcp.ts"],
    cwd: process.cwd(),
    env: { CODEX_POCKET_STATE_DIR: directory, POCKET_CHILD_ID: child.id, POCKET_COMMAND_ID: command.id },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["message_parent"]
    );
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties ?? {}), ["message"]);
    const sent = await client.callTool({ name: "message_parent", arguments: { message: "Which color?" } });
    assert.equal(sent.isError, undefined);
    await client.callTool({ name: "message_parent", arguments: { message: "Which color?" } });
    assert.equal(store.mail.pending(owner).length, 1);
    assert.equal(store.mail.pending(owner)[0].childId, child.id);
    assert.deepEqual(store.mail.pending("other-parent"), []);
    const invalid = await client.callTool({ name: "message_parent", arguments: { message: "Hello", id: "other" } });
    assert.equal(invalid.isError, true);
    store.closeChild(owner, child.id);
    const late = await client.callTool({ name: "message_parent", arguments: { message: "Too late" } });
    assert.equal(late.isError, true);
  } finally {
    await client.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
