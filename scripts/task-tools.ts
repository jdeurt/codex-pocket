import { type McpServer } from "@modelcontextprotocol/server";
import { toolError } from "../src/server/mcp-result";
import { searchTaskArchivePage } from "../src/server/task-search";
import { z } from "zod";

const MAX_QUERY_LENGTH = 2000;

/** Preserve the original result-array content while adding explicit mode/page information, even for no matches.
@param owner - Authorized parent identity supplied by the MCP launcher.
@param query - Earlier-task reference.
@param offset - Ranked passage offset.
@returns MCP content and structured retrieval evidence, or the standard tool error.
*/
async function search(owner: string, query: string, offset: number) {
  return searchTaskArchivePage(owner, query, offset)
    .then((page) => ({
      content: [
        { type: "text" as const, text: JSON.stringify(page.results) },
        { type: "text" as const, text: JSON.stringify({ retrieval: page.retrieval, pagination: page.pagination }) },
      ],
      structuredContent: page,
    }))
    .catch(toolError);
}

/** Register earlier-task retrieval at the existing model-facing MCP entry point.
@param server - Owning MCP server.
@param owner - Launcher-authorized parent, never supplied by a search caller.
*/
export function registerTaskTools(server: McpServer, owner: string) {
  server.registerTool(
    "pocket_task_search",
    {
      description:
        "Silently search earlier tasks using local QMD. Read the matching Markdown passage and task timeline, " +
        "then follow source references for exact originals. Results report keyword/hybrid mode, reranking, " +
        "omissions and pagination. Pass nextOffset to continue; empty queries return no matches.",
      inputSchema: z
        .object({ query: z.string().trim().max(MAX_QUERY_LENGTH), offset: z.number().int().nonnegative().default(0) })
        .strict(),
    },
    ({ query, offset }) => search(owner, query, offset)
  );
}
