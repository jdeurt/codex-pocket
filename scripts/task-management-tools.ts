import { type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolResult } from "../src/server/mcp-result";
import { readTaskLedger, changeTask } from "../src/tasks/management";
import { taskOperationSchema } from "../src/tasks/lifecycle";

const REASON_LENGTH = 1000;
const changeSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    operation: taskOperationSchema,
    reason: z.string().trim().min(1).max(REASON_LENGTH),
  })
  .strict();

/** Return the current task revision and explainable decisions for review.
@param parentId - Launcher-authorized parent.
@returns MCP result with source-backed ledger data.
*/
function inspectTasks(parentId: string) {
  return toolResult(readTaskLedger.bind(undefined, parentId));
}

/** Apply an explicitly reviewed operation to its inspected parent revision.
@param parentId - Launcher-authorized parent.
@param input - Concrete reviewed change and audit explanation.
@returns Committed state or a stale-review diagnostic.
*/
function applyChange(parentId: string, input: z.infer<typeof changeSchema>) {
  return toolResult(changeTask.bind(undefined, parentId, input.revision, input.operation, input.reason));
}

/** Register centralized task inspection and explicit repairs under the existing parent boundary.
@param server - Owning MCP server.
@param parentId - Launcher-authorized parent, never supplied by a tool caller.
*/
export function registerTaskManagementTools(server: McpServer, parentId: string) {
  server.registerTool(
    "pocket_task_inspect",
    {
      description:
        "Inspect tasks, exact source references, unresolved provenance, lifecycle evidence and decision history. " +
        "The returned revision is required for reviewed changes. Model turn completion does not establish task resolution.",
      inputSchema: z.object({}).strict(),
    },
    inspectTasks.bind(undefined, parentId)
  );
  server.registerTool(
    "pocket_task_change",
    {
      description:
        "Apply a concrete reviewed work, retention, move, split or merge operation at the inspected revision. " +
        "Work changes require supporting task-member event IDs. Resolve explicit content spans for multi-task messages. " +
        "Apply historical membership repairs only after the user authorizes the concrete proposal; never silently " +
        "reclassify history. Source originals remain immutable. Retention does not imply completion.",
      inputSchema: changeSchema,
    },
    applyChange.bind(undefined, parentId)
  );
}
