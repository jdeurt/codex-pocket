import { scheduleInput, schedulePatch, schedules } from "../src/server/schedules";
import { McpServer } from "@modelcontextprotocol/server";
import { log } from "../src/server/logging";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const threadId = process.env.POCKET_THREAD_ID;

if (!threadId) {
  throw new Error("POCKET_THREAD_ID is required; launch this MCP through Pocket.");
}

const owner = threadId;
const idSchema = z.object({ id: z.string().uuid() }).strict();
const result = async (operation: () => unknown | Promise<unknown>) => {
  try {
    const value = await operation();

    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  } catch (error) {
    log().error({ error }, "schedule.tool_failed");

    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    };
  }
};

serveStdio(
  () => {
    const server = new McpServer(
      { name: "pocket", version: "1.0.0" },
      {
        instructions:
          "Manage schedules for this Pocket chat. Calendar is RFC 5545 DTSTART plus optional RRULE/RDATE/EXDATE, or a single VEVENT/VCALENDAR. Use UTC Z or IANA TZID. A title is shown in chat; the body is delivered to the agent when due. Active values in stored records are SQLite booleans (0/1), and dates are Unix milliseconds.",
      }
    );
    server.registerTool(
      "schedule_create",
      {
        description:
          "Create a one-time or recurring Pocket task with a title, future instruction body and validated iCalendar event.",
        inputSchema: scheduleInput,
      },
      (input) => result(() => schedules().create(owner, input))
    );
    server.registerTool(
      "schedule_list",
      { description: "List active and inactive tasks for this Pocket chat.", inputSchema: z.object({}).strict() },
      () => result(() => schedules().list(owner))
    );
    server.registerTool(
      "schedule_get",
      { description: "Read a task and its revision before changing it.", inputSchema: idSchema },
      ({ id }) => result(() => schedules().get(owner, id))
    );
    server.registerTool(
      "schedule_update",
      {
        description:
          "Change a task's title, body, calendar or active state. Pass its expectedRevision to detect concurrent changes.",
        inputSchema: idSchema.extend({
          changes: schedulePatch,
          expectedRevision: z.number().int().positive().optional(),
        }),
      },
      ({ id, changes, expectedRevision }) => result(() => schedules().update(owner, id, changes, expectedRevision))
    );
    server.registerTool(
      "schedule_delete",
      {
        description:
          "Delete future occurrences and pending deliveries. Already in-flight/accepted messages cannot be recalled. Chat history markers are retained.",
        inputSchema: idSchema,
      },
      ({ id }) => result(() => schedules().delete(owner, id))
    );

    return server;
  },
  { onerror: (error) => log().error({ error }, "schedule.mcp_error") }
);
