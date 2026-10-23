import { type Schedule, scheduleSchema } from "../../src/server/schedules";
import { mkdtemp, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toolJson } from "../fixtures/tool-json";

const DAY_MS = 86_400_000;
const SCHEDULE_TOOLS = ["schedule_create", "schedule_list", "schedule_get", "schedule_update", "schedule_delete"];

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
Formats an independent future UTC instant for the submitted one-time calendar.
@returns Basic UTC DTSTART value one day after the native current clock.
*/
function futureStart() {
  return new Date(Date.now() + DAY_MS)
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
Discovers the schedule tools and creates the independently specified future task.
@param client - Connected real stdio MCP client.
@param calendar - Independently supplied one-time UTC recurrence.
@returns Canonical created schedule after real discovery and validation.
*/
async function createScheduledCheck(client: Client, calendar: string) {
  const { tools } = await client.listTools();

  for (const name of SCHEDULE_TOOLS) {
    assert.ok(
      tools.some((tool) => tool.name === name),
      `Missing schedule tool: ${name}`
    );
  }

  return scheduleSchema.parse(
    await call(client, "schedule_create", {
      title: "MCP check",
      body: "Read project status.",
      calendar,
    })
  );
}

/**
Checks persisted identity and original content after pausing and renaming a task.
@param client - Connected real stdio MCP client.
@param id - Original created identity retained across the full CRUD sequence.
@param updated - Canonical paused schedule returned by the preceding mutation.
@param calendar - Original submitted recurrence, which the title update must retain.
@returns Canonical stored schedule from the actual get operation.
*/
async function readUpdatedSchedule(client: Client, id: string, updated: Schedule, calendar: string) {
  assert.equal(updated.title, "Updated MCP check");

  const fetched = scheduleSchema.parse(await call(client, "schedule_get", { id }));

  assert.deepEqual(fetched, updated);
  assert.equal(fetched.id, id);
  assert.equal(fetched.title, "Updated MCP check");
  assert.equal(fetched.body, "Read project status.");
  assert.equal(fetched.calendar, calendar);

  return fetched;
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
@param id - Original created identity, independent of the later listing.
@param calendar - Original submitted recurrence.
@returns Native rejected-tool envelope for the workflow's error assertion.
*/
async function rejectInvalidSchedule(client: Client, renamed: Schedule, id: string, calendar: string) {
  assert.equal(renamed.active, 0);
  const listed = scheduleSchema.array().parse(await call(client, "schedule_list", {}));

  assert.deepEqual(
    listed.map((schedule) => ({
      id: schedule.id,
      threadId: schedule.threadId,
      title: schedule.title,
      body: schedule.body,
      calendar: schedule.calendar,
      active: schedule.active,
    })),
    [{ id, threadId: "mcp-test", title: "Still paused", body: "Read project status.", calendar, active: 0 }]
  );
  assert.deepEqual(listed[0], renamed);

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
  const calendar = `DTSTART:${futureStart()}\nRRULE:FREQ=DAILY;COUNT=1`;
  const created = await createScheduledCheck(client, calendar);
  const updated = scheduleSchema.parse(
    await call(client, "schedule_update", {
      id: created.id,
      changes: { title: "Updated MCP check", active: false },
      expectedRevision: created.revision,
    })
  );
  const fetched = await readUpdatedSchedule(client, created.id, updated, calendar);
  const renamed = await renamePausedSchedule(client, created.id, fetched);
  const invalid = await rejectInvalidSchedule(client, renamed, created.id, calendar);

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
