import { type Schedule, scheduleSchema } from "../src/server/schedules";
import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toolJson } from "./fixtures/tool-json";

const DAY_MS = 86_400_000;
const MAIN_TOOL_NAMES = [
  "schedule_create",
  "schedule_list",
  "schedule_get",
  "schedule_update",
  "schedule_delete",
  "side_pocket_capabilities",
  "side_pocket_create",
  "side_pocket_list",
  "side_pocket_get",
  "side_pocket_send",
  "side_pocket_cancel",
  "side_pocket_answer",
  "side_pocket_close",
  "side_pocket_resume",
  "side_pocket_sessions",
  "side_pocket_adopt",
  "spinner_set",
  "spinner_status",
  "spinner_reset",
  "spinner_delete",
  "pocket_realtime_inspect",
  "pocket_realtime_voice",
  "pocket_realtime_model",
  "pocket_session_inspect",
  "pocket_session_settings",
];

const REALTIME_TOOL_INPUTS = [
  { name: "pocket_realtime_inspect", properties: [], required: [] },
  { name: "pocket_realtime_voice", properties: ["voice"], required: ["voice"] },
  { name: "pocket_realtime_model", properties: ["model"], required: ["model"] },
];

/**
Compares discovered and expected tool names without relying on registration order.
@param left - First tool name.
@param right - Second tool name.
@returns Name ordering for exact catalog comparison.
*/
const compareNames = (left: string, right: string) => left.localeCompare(right);

/**
Requires a successful MCP envelope before decoding its JSON tool result.
@param client - Connected real stdio MCP client.
@param name - Bundled schedule tool selected by this workflow.
@param arguments_ - Native tool input validated by the running MCP server.
@returns Unknown JSON decoded once for the operation's canonical schedule schema.
*/
async function call(client: Client, name: string, arguments_: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: arguments_ });

  assert.equal(result.isError, undefined, JSON.stringify(result));

  return toolJson(result);
}

/**
Formats a future UTC instant in the calendar protocol only after MCP discovery succeeds.
@returns Basic UTC DTSTART value one day after the native current clock.
*/
function futureStart() {
  return new Date(Date.now() + DAY_MS)
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
Checks discovery before choosing a future native calendar instant and creating its schedule.
@param client - Connected real stdio MCP client.
@returns Canonical created schedule after real discovery and validation.
*/
async function createScheduledCheck(client: Client) {
  const { tools } = await client.listTools();

  assert.equal(tools.length, MAIN_TOOL_NAMES.length);
  assert.deepEqual(tools.map((tool) => tool.name).toSorted(compareNames), MAIN_TOOL_NAMES.toSorted(compareNames));

  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }

  for (const expected of REALTIME_TOOL_INPUTS) {
    const tool = tools.find((entry) => entry.name === expected.name);

    assert.ok(tool, expected.name);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), expected.properties);
    assert.deepEqual(tool.inputSchema.required ?? [], expected.required);
  }

  return scheduleSchema.parse(
    await call(client, "schedule_create", {
      title: "MCP check",
      body: "Read project status.",
      calendar: `DTSTART:${futureStart()}`,
    })
  );
}

/**
Reads back an update only after checking its returned title.
@param client - Connected real stdio MCP client.
@param id - Original created identity retained across the full CRUD sequence.
@param updated - Canonical paused schedule returned by the preceding mutation.
@returns Canonical stored schedule from the actual get operation.
*/
async function readUpdatedSchedule(client: Client, id: string, updated: Schedule) {
  assert.equal(updated.title, "Updated MCP check");

  return scheduleSchema.parse(await call(client, "schedule_get", { id }));
}

/**
Renames a read-back schedule only after verifying its paused state.
@param client - Connected real stdio MCP client.
@param id - Original created identity retained across the full CRUD sequence.
@param fetched - Canonical read-back schedule with the native current revision.
@returns Canonical renamed schedule, still paused.
*/
async function renamePausedSchedule(client: Client, id: string, fetched: Schedule) {
  assert.equal(fetched.active, 0);

  return scheduleSchema.parse(
    await call(client, "schedule_update", {
      id,
      changes: { title: "Still paused" },
      expectedRevision: fetched.revision,
    })
  );
}

/**
Checks paused listing before submitting the original invalid-calendar input.
@param client - Connected real stdio MCP client.
@param renamed - Canonical schedule returned by the rename operation.
@returns Native rejected-tool envelope for the workflow's error assertion.
*/
async function rejectInvalidSchedule(client: Client, renamed: Schedule) {
  assert.equal(renamed.active, 0);
  assert.equal(Array.isArray(await call(client, "schedule_list", {})), true);

  return client.callTool({
    name: "schedule_create",
    arguments: {
      title: "Invalid",
      body: "Nothing",
      calendar: "DTSTART:20260230T090000Z",
    },
  });
}

/**
Exercises the existing create, pause, read, rename, rejection and delete flow through native stdio.
@param client - Connected real MCP client whose lifetime belongs to the outer workflow.
*/
async function checkScheduleTools(client: Client) {
  const created = await createScheduledCheck(client);
  const updated = scheduleSchema.parse(
    await call(client, "schedule_update", {
      id: created.id,
      changes: { title: "Updated MCP check", active: false },
      expectedRevision: created.revision,
    })
  );
  const fetched = await readUpdatedSchedule(client, created.id, updated);
  const renamed = await renamePausedSchedule(client, created.id, fetched);
  const invalid = await rejectInvalidSchedule(client, renamed);

  assert.equal(invalid.isError, true);
  await call(client, "schedule_delete", { id: created.id });
  assert.deepEqual(await call(client, "schedule_list", {}), []);
}

await test("the bundled MCP process validates input and performs schedule CRUD over real stdio", async () => {
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
      CODEX_THREAD_ID: "",
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    await checkScheduleTools(client);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
