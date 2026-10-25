import { registerTaskManagementTools } from "./task-management-tools";
import { t as captureResult } from "try";
import { type McpServer } from "@modelcontextprotocol/server";
import { toolError } from "../src/server/mcp-result";
import { searchTaskArchivePage } from "../src/tasks/retrieval/runtime";
import { z } from "zod";

const MAX_QUERY_LENGTH = 2000;

/** Encode source-validated retrieval output without changing passage evidence.
@param page - Completed search page.
@returns Native MCP content and metadata.
*/
function searchContent(page: Awaited<ReturnType<typeof searchTaskArchivePage>>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(page.results) },
      { type: "text" as const, text: JSON.stringify({ retrieval: page.retrieval, pagination: page.pagination }) },
    ],
    structuredContent: page,
  };
}

/** Preserve the original result-array content while adding explicit mode/page information, even for no matches.
@param owner - Authorized parent identity supplied by the MCP launcher.
@param query - Earlier-task reference.
@param offset - Ranked passage offset.
@returns MCP content and structured retrieval evidence, or the standard tool error.
*/
async function search(owner: string, query: string, offset: number) {
  const searched = await captureResult(searchTaskArchivePage, owner, query, offset);

  if (!searched.ok) {
    return toolError(searched.error);
  }

  const page = searched.value;
  const encoded = captureResult(searchContent, page);

  return encoded.ok ? encoded.value : toolError(encoded.error);
}

/** Adapt validated search fields to the owned retrieval lifecycle.
@param owner - Authorized parent.
@param input - Validated query and offset.
@returns Native search response.
*/
function searchInput(owner: string, input: { query: string; offset: number }) {
  return search(owner, input.query, input.offset);
}

/** Register earlier-task retrieval at the existing model-facing MCP entry point.
@param server - Owning MCP server.
@param owner - Launcher-authorized parent, never supplied by a search caller.
*/
export function registerTaskTools(server: McpServer, owner: string) {
  registerTaskManagementTools(server, owner);
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
    searchInput.bind(undefined, owner)
  );
}
