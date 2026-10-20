import { delegationBody, delegationInput, delegationKey, delegations } from "../src/server/delegations";
import { type McpServer } from "@modelcontextprotocol/server";
import { findClaudeBinary } from "../src/server/harness/claude-binary";
import { harnessCapabilities } from "../src/server/harness/types";
import { toolResult } from "../src/server/mcp-result";
import { z } from "zod";

const CLOSE_TIMEOUT_MS = 15_000;
const idSchema = z.object({ id: z.uuid() }).strict();
const answerSchema = idSchema.extend({ requestId: z.uuid(), answer: z.record(z.string(), z.unknown()) });
const sendSchema = idSchema.extend({
  message: delegationBody,
  idempotencyKey: delegationKey,
  mode: z.enum(["steer", "queue"]).default("steer"),
  supersedes: z.array(z.uuid()).default([]),
});
const cancelSchema = idSchema.extend({ commandIds: z.array(z.uuid()).min(1), reason: delegationBody });

/**
Waits for host-confirmed native closure after recording a durable close request.
@param owner - Parent identity authorizing the child.
@param id - Child identity to close.
@returns Closed child record; a timeout leaves the durable request intact.
*/
async function closeChild(owner: string, id: string) {
  const store = delegations();

  return new Promise<ReturnType<typeof store.get>>((resolve, reject) => {
    const resources: { timer?: NodeJS.Timeout; unsubscribe?: () => void } = {};
    const cleanup = () => {
      clearTimeout(resources.timer);
      resources.unsubscribe?.();
    };
    const isSatisfied = () => {
      const child = store.get(owner, id);

      if (child.status === "closed") {
        cleanup();
        resolve(child);

        return true;
      }

      return false;
    };

    resources.unsubscribe = store.subscribe(isSatisfied);
    resources.timer = setTimeout(() => {
      // A final read covers a lost close notification without another poller.
      if (isSatisfied()) {
        return;
      }

      cleanup();
      reject(
        new Error(
          "Close is recorded but the host has not confirmed process exit. Check side_pocket_list before resuming."
        )
      );
    }, CLOSE_TIMEOUT_MS);

    try {
      store.closeChild(owner, id);
      isSatisfied();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Operation failed.", { cause: error }));
    }
  });
}

/**
Registers parent-scoped delegation tools with durable idempotency and confirmed closure.
@param server - Native MCP server receiving the tools.
@param owner - Parent identity authorizing every operation.
*/
export function registerDelegationTools(server: McpServer, owner: string) {
  server.registerTool(
    "side_pocket_capabilities",
    {
      description:
        "Read the capabilities and permission mapping of available delegation harnesses. Main Pocket always uses Codex.",
      inputSchema: z.object({}).strict(),
    },
    () =>
      toolResult(() => ({
        codex: { ...harnessCapabilities.codex, available: true },
        claude: { ...harnessCapabilities.claude, available: !!findClaudeBinary() },
      }))
  );
  server.registerTool(
    "side_pocket_create",
    {
      description:
        "Create a Codex or Claude Side Pocket and queue its first assignment. Reuse idempotencyKey when retrying the same creation. Permissions inherit the parent; cwd defaults to the parent folder. Coordinate shared files or choose a separate worktree.",
      inputSchema: delegationInput,
    },
    (input) => toolResult(() => delegations().create(owner, input))
  );
  server.registerTool(
    "side_pocket_list",
    {
      description:
        "List this parent's Side Pockets, including titles, IDs, harnesses, session IDs and lifecycle states. Closed sessions remain resumable.",
      inputSchema: z.object({}).strict(),
    },
    () => toolResult(() => delegations().list(owner))
  );
  server.registerTool(
    "side_pocket_get",
    {
      description:
        "Inspect a Side Pocket, its message history, delivery results and harness requests. Check unknown outcomes before continuing interrupted work.",
      inputSchema: idSchema,
    },
    ({ id }) =>
      toolResult(() => {
        const store = delegations();

        return {
          ...store.get(owner, id),
          commands: store.queue.list(owner, id),
          messages: store.mail.history(owner, id),
          requests: store.mail.requests(owner, id),
        };
      })
  );
  server.registerTool(
    "side_pocket_send",
    {
      description:
        "Steer the current task by default. Active steering uses its existing execution slot and bypasses later assignments. Set mode=queue only for an explicitly distinct later task. Idle delivery resumes the saved session subject to normal capacity. The returned receipt is durable. pending or sending does not prove native acceptance. Inspect side_pocket_get for accepted, unsupported, failed, or unknown outcomes. Do not resend unknown outcomes with a new key. supersedes atomically cancels only selected unsent queued assignments. It preserves unrelated work and audit history. Reuse idempotencyKey only for identical retries.",
      inputSchema: sendSchema,
    },
    ({ id, message, idempotencyKey, mode, supersedes }) =>
      toolResult(() => delegations().queue.send(owner, id, idempotencyKey, message, mode, supersedes))
  );
  server.registerTool(
    "side_pocket_cancel",
    {
      description:
        "Cancel exact unsent queued assignment IDs with an audit reason, preserving unrelated work and native in-flight deliveries. Repeating cancellation does not resend work or replace the original audit reason.",
      inputSchema: cancelSchema,
    },
    ({ id, commandIds, reason }) =>
      toolResult(() => {
        const store = delegations();

        store.get(owner, id);

        return { cancelled: store.queue.steering.cancel(owner, id, commandIds, reason) };
      })
  );
  server.registerTool(
    "side_pocket_answer",
    {
      description:
        "Answer a pending harness question/approval using its request ID from side_pocket_get. For ordinary message_parent questions, reply with side_pocket_send.",
      inputSchema: answerSchema,
    },
    ({ id, requestId, answer }) => toolResult(() => delegations().mail.answer(owner, id, requestId, answer))
  );
  server.registerTool(
    "side_pocket_close",
    {
      description:
        "Close this Side Pocket's actual harness process and cancel queued work. Keep its ID, title and saved history for later resumption. Returns after the host confirms closure.",
      inputSchema: idSchema,
    },
    ({ id }) => toolResult(() => closeChild(owner, id))
  );
  server.registerTool(
    "side_pocket_resume",
    {
      description:
        "Reopen a closed Side Pocket's saved session for follow-up messages. Use side_pocket_send to assign the next work; inspect history first if its previous outcome was unknown.",
      inputSchema: idSchema,
    },
    ({ id }) => toolResult(() => delegations().resume(owner, id))
  );
}
