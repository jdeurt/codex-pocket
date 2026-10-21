import { type McpServer } from "@modelcontextprotocol/server";
import { callRealtime } from "../src/server/realtime-client";
import { callSession } from "../src/server/session-client";
import { sessionSettingsSchema } from "../src/server/session-settings";
import { toolResult } from "../src/server/mcp-result";
import { z } from "zod";

/**
Expose parent-only inspection and explicit settings changes through the existing host connection.
@param server - Main Pocket MCP server; never registered on the child MCP surface.
*/
export function registerSessionTools(server: McpServer) {
  server.registerTool(
    "pocket_realtime_inspect",
    {
      description:
        "Read this main Pocket's current realtime selection and actual v2 voice list. The runtime does not expose a model catalog.",
      inputSchema: z.object({}).strict(),
    },
    () => toolResult(() => callRealtime())
  );
  server.registerTool(
    "pocket_realtime_voice",
    {
      description:
        "Select an available realtime voice for this main Pocket's next voice session. Active speech is unchanged.",
      inputSchema: z.object({ voice: z.string().min(1) }).strict(),
    },
    ({ voice }) => toolResult(() => callRealtime({ voice }))
  );
  server.registerTool(
    "pocket_realtime_model",
    {
      description:
        "Select a realtime model override for this main Pocket's next voice session. The runtime has no model catalog; the next native start validates availability. Pass null to clear an override and use the configured default. Active speech is unchanged.",
      inputSchema: z.object({ model: z.string().trim().min(1).nullable() }).strict(),
    },
    ({ model }) => toolResult(() => callRealtime({ model }))
  );
  server.registerTool(
    "pocket_session_inspect",
    {
      description:
        "Inspect this main Pocket's effective model, effort, active turn and reported context/token usage. Unknown values remain null.",
      inputSchema: z.object({}).strict(),
    },
    () => toolResult(() => callSession())
  );
  server.registerTool(
    "pocket_session_settings",
    {
      description:
        "Explicitly change this main Pocket's model or reasoning effort for subsequent turns. Active work and existing delegates retain their settings. Accepted settings persist across reconnects/restarts. Never retry an uncertain result without inspection.",
      inputSchema: sessionSettingsSchema,
    },
    (settings) => toolResult(() => callSession(settings))
  );
}
