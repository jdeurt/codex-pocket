import { scheduleInput, schedulePatch, schedules } from "../src/server/schedules";
import { McpServer } from "@modelcontextprotocol/server";
import { log } from "../src/server/logging";
import { registerDelegationTools } from "./delegation-tools";
import { registerSpinnerTools } from "./spinner-tools";
import { toolResult as result } from "../src/server/mcp-result";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const threadId = process.env.POCKET_THREAD_ID;

if (!threadId) {
  throw new Error("POCKET_THREAD_ID is required; launch this MCP through Pocket.");
}

const owner = threadId;
const idSchema = z.object({ id: z.string().uuid() }).strict();

serveStdio(
  () => {
    const server = new McpServer(
      { name: "pocket", version: "1.0.0" },
      {
        instructions:
          "Manage schedules and Side Pockets for this main Pocket chat. Calendar is RFC 5545 DTSTART plus optional RRULE/RDATE/EXDATE, or a single VEVENT/VCALENDAR. Use UTC Z or IANA TZID. The schedule body is delivered to the agent when due; triggers are hidden from the phone chat. Active values in stored records are SQLite booleans (0/1), and dates are Unix milliseconds.",
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
          "Delete future occurrences and pending deliveries. Already in-flight/accepted messages cannot be recalled. Accepted delivery history is retained.",
        inputSchema: idSchema,
      },
      ({ id }) => result(() => schedules().delete(owner, id))
    );

    registerDelegationTools(server, owner);
    registerSpinnerTools(server, owner);

    return server;
  },
  { onerror: (error) => log().error({ error }, "schedule.mcp_error") }
);
