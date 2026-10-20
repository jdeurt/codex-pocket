import { spinnerId, spinners } from "../src/server/spinners";
import { type McpServer } from "@modelcontextprotocol/server";
import { toolResult } from "../src/server/mcp-result";
import { z } from "zod";

const MAX_PATH_LENGTH = 4096;

export function registerSpinnerTools(server: McpServer, owner: string) {
  const mainOnly = (operation: () => unknown) =>
    toolResult(() => {
      // Check on every invocation, even if a child re-enables the main MCP server.
      if (
        process.env.POCKET_CHILD_ID ||
        process.env.POCKET_COMMAND_ID ||
        process.env.POCKET_MAIN_THREAD_ID !== owner ||
        (process.env.CODEX_THREAD_ID && process.env.CODEX_THREAD_ID !== owner)
      ) {
        throw new Error("Spinner tools are available only to the main Pocket session.");
      }

      return operation();
    });
  server.registerTool(
    "spinner_set",
    {
      description:
        "Set Pocket's thinking spinner from an absolute LOCAL file path, after uploading/downloading it first. Copies a bounded validated GIF, PNG, JPEG or WebP into private managed state; preserves GIF/WebP animation. Main Pocket only; use when the user asks. Returns current preference and saved managed IDs without source paths.",
      inputSchema: z
        .object({
          path: z.string().min(1).max(MAX_PATH_LENGTH).describe("Absolute path to a local raster image; no URL."),
        })
        .strict(),
    },
    ({ path }) => mainOnly(() => spinners().set(path))
  );
  server.registerTool(
    "spinner_status",
    {
      description:
        "Read the current thinking spinner and saved library metadata/managed IDs. current:null means the default SVG. tone stores one animation-wide contrast multiplier and additive normalized sRGB brightness offset. Main Pocket only.",
      inputSchema: z.object({}).strict(),
    },
    () => mainOnly(() => spinners().status())
  );
  server.registerTool(
    "spinner_reset",
    {
      description:
        "Restore the default SVG thinking spinner. Retains saved custom images/GIFs. Main Pocket only; use when the user asks.",
      inputSchema: z.object({}).strict(),
    },
    () => mainOnly(() => spinners().reset())
  );
  server.registerTool(
    "spinner_delete",
    {
      description:
        "Delete a saved custom spinner by managed ID from spinner_status/set. Deletes ONLY Pocket's managed copy, never the user's original/upload. Deleting the active image safely selects the default SVG. Main Pocket only; use when the user asks.",
      inputSchema: z.object({ id: spinnerId }).strict(),
    },
    ({ id }) => mainOnly(() => spinners().delete(id))
  );
}
