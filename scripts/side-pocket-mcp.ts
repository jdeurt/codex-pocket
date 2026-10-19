import { McpServer } from "@modelcontextprotocol/server";
import { delegations } from "../src/server/delegations";
import { log } from "../src/server/logging";
import { parentMessageInput } from "../src/server/delegation-mail";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toolResult } from "../src/server/mcp-result";

const childId = process.env.POCKET_CHILD_ID;
const commandId = process.env.POCKET_COMMAND_ID;

if (!childId || !commandId) {
  throw new Error("Launch this MCP through a managed Side Pocket.");
}

const child = childId;
const command = commandId;
serveStdio(
  () => {
    const server = new McpServer({ name: "pocket_parent", version: "1.0.0" });
    server.registerTool(
      "message_parent",
      {
        description:
          "Send a message to your parent Pocket: progress, a question, results or a completion report. Parent replies arrive as follow-ups in this session.",
        inputSchema: parentMessageInput,
      },
      (input) => toolResult(() => delegations().mail.message(child, command, input))
    );

    return server;
  },
  { onerror: (error) => log().error({ error }, "side_pocket.mcp_error") }
);
