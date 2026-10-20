import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { DelegationStore } from "../src/server/delegations";
import { type SidePocket } from "../src/server/delegation-data";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type ToolResponse = Awaited<ReturnType<Client["callTool"]>>;
type NativeTools = Awaited<ReturnType<Client["listTools"]>>["tools"];
const owner = "parent-chat";

/**
Persists the original parent policy before creating its managed child assignment.
@param store - Private native delegation store owned by this workflow.
@returns Canonical created child.
*/
function createManagedChild(store: DelegationStore) {
  store.saveParent(owner, { cwd: "/tmp", policy: { sandbox: "danger-full-access", approval: "never" } });

  return store.create(owner, { title: "Check", body: "Check messaging", idempotencyKey: "check" });
}

/**
Requires a real queued command before binding the child-only MCP identity.
@param store - Private native store with no dispatching worker.
@returns Canonical child and claimed native command.
*/
function childBinding(store: DelegationStore) {
  const child = createManagedChild(store);
  const command = store.queue.claim(owner, child.id);

  assert.ok(command);

  return { child, command };
}

/**
Checks the actual native tool inventory before submitting the original child report.
@param client - Connected real child-only stdio MCP client.
@param tools - Native SDK tool inventory returned by the running child server.
@returns Native report receipt.
*/
async function sendScopedReport(client: Client, tools: NativeTools) {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["message_parent"]
  );
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties ?? {}), ["message"]);

  return client.callTool({ name: "message_parent", arguments: { message: "Which color?" } });
}

/**
Checks report retry deduplication and parent isolation before attempting a forged identity.
@param client - Connected real child-only MCP client.
@param store - Private native store receiving child reports.
@param child - Original canonical managed identity.
@param sent - Native result from the first report.
@returns Native rejection envelope for the forged argument.
*/
async function rejectForgedReport(client: Client, store: DelegationStore, child: SidePocket, sent: ToolResponse) {
  assert.equal(sent.isError, undefined);
  await client.callTool({ name: "message_parent", arguments: { message: "Which color?" } });
  assert.equal(store.mail.pending(owner).length, 1);
  assert.equal(store.mail.pending(owner)[0].childId, child.id);
  assert.deepEqual(store.mail.pending("other-parent"), []);

  return client.callTool({ name: "message_parent", arguments: { message: "Hello", id: "other" } });
}

/**
Requires forged input rejection before closing the active child and sending its late report.
@param client - Connected real child-only MCP client.
@param store - Private native store owning the child lifecycle.
@param child - Original canonical managed identity.
@param invalid - Native rejection result from the forged report.
@returns Native rejection envelope for work after closure.
*/
async function rejectClosedReport(client: Client, store: DelegationStore, child: SidePocket, invalid: ToolResponse) {
  assert.equal(invalid.isError, true);
  store.closeChild(owner, child.id);

  return client.callTool({ name: "message_parent", arguments: { message: "Too late" } });
}

/**
Checks the existing child-only report, retry, parent-scope and closed-command flow over native stdio.
@param client - Connected real child-only MCP client.
@param store - Private native store owning the recorded identities and reports.
@param child - Original canonical managed child.
*/
async function checkChildReports(client: Client, store: DelegationStore, child: SidePocket) {
  const { tools } = await client.listTools();
  const sent = await sendScopedReport(client, tools);
  const invalid = await rejectForgedReport(client, store, child, sent);
  const late = await rejectClosedReport(client, store, child, invalid);

  assert.equal(late.isError, true);
}

await test("a child MCP exposes only message_parent and routes content to its recorded parent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-child-mcp-"));
  const store = new DelegationStore(directory);
  const { child, command } = childBinding(store);
  const client = new Client({ name: "child-check", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/side-pocket-mcp.ts"],
    cwd: process.cwd(),
    env: {
      CODEX_THREAD_ID: "",
      CODEX_POCKET_STATE_DIR: directory,
      POCKET_CHILD_ID: child.id,
      POCKET_COMMAND_ID: command.id,
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    await checkChildReports(client, store, child);
  } finally {
    await client.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
