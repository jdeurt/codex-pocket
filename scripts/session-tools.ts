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
    "pocket_session_models",
    {
      description: "List Pi's provider/model catalog. Use a listed provider/model ID with pocket_session_settings.",
      inputSchema: z.object({}).strict(),
    },
    () => toolResult(() => callSession(undefined, true))
  );
  server.registerTool(
    "pocket_realtime_inspect",
    {
      description:
        "Read OpenAI realtime voices, central next-session settings, and saved finalized speech with handoff status. Consult this history when a voice request refers to earlier spoken context.",
      inputSchema: z.object({}).strict(),
    },
    () => toolResult(() => callRealtime())
  );
  server.registerTool(
    "pocket_realtime_voice",
    {
      description:
        "Set the central OpenAI voice for future voice sessions. Inspect available voices first. Active speech is unchanged.",
      inputSchema: z.object({ voice: z.string().min(1) }).strict(),
    },
    ({ voice }) => toolResult(() => callRealtime({ voice }))
  );
  server.registerTool(
    "pocket_realtime_model",
    {
      description:
        "Set the central OpenAI Realtime model override for future voice sessions. OpenAI validates availability when a session starts. Pass null to restore the provider default. Active speech is unchanged.",
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
