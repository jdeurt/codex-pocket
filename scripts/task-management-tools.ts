import { type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolResult } from "../src/server/mcp-result";
import { readTaskLedger, changeTask } from "../src/tasks/management";
import { readOpenAIApiKey } from "../src/server/pocket-settings";
import { proposeTaskAssignment } from "../src/tasks/proposals";
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

/** Resolve the current provider credential for an explicitly requested historical proposal.
@param parentId - Authorized parent.
@param input - Exact request event selected for review.
@returns A proposal only; membership is unchanged.
*/
async function prepareProposal(parentId: string, input: { eventId: string }) {
  const key = await readOpenAIApiKey();

  if (!key) {
    throw new Error("Add an OpenAI API key in Pocket Settings to prepare a semantic review proposal.");
  }

  return proposeTaskAssignment(parentId, input.eventId, key);
}

/** Adapt proposal preparation to the native MCP result boundary.
@param parentId - Authorized parent.
@param input - Selected request event.
@returns Native proposal or an explicit diagnostic.
*/
function proposalResult(parentId: string, input: { eventId: string }) {
  return toolResult(prepareProposal.bind(undefined, parentId, input));
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
    "pocket_task_propose",
    {
      description:
        "Prepare a reviewable semantic assignment proposal for a selected historical request event. " +
        "This may call the classifier but does not change membership, replay requests, or dispatch delegates. " +
        "Show the concrete proposal before applying a historical repair.",
      inputSchema: z.object({ eventId: z.string().min(1) }).strict(),
    },
    proposalResult.bind(undefined, parentId)
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
