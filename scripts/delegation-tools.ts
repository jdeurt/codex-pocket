import { delegationBody, delegationInput, delegationKey, delegations } from "../src/server/delegations";
import { type McpServer } from "@modelcontextprotocol/server";
import { findClaudeBinary } from "../src/server/harness/claude-binary";
import { harnessCapabilities } from "../src/server/harness/types";
import { toolResult } from "../src/server/mcp-result";
import { z } from "zod";

const CLOSE_TIMEOUT_MS = 15_000;
const idSchema = z.object({ id: z.uuid() }).strict();

async function closeChild(owner: string, id: string) {
  const store = delegations();

  return new Promise<ReturnType<typeof store.get>>((resolve, reject) => {
    const resources: { timer?: NodeJS.Timeout; unsubscribe?: () => void } = {};
    const cleanup = () => {
      clearTimeout(resources.timer);
      resources.unsubscribe?.();
    };
    const check = () => {
      const child = store.get(owner, id);

      if (child.status === "closed") {
        cleanup();
        resolve(child);

        return true;
      }

      return false;
    };

    resources.unsubscribe = store.subscribe(check);
    resources.timer = setTimeout(() => {
      // A final read covers a lost close notification without another poller.
      if (check()) {
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
      check();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Operation failed.", { cause: error }));
    }
  });
}

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
          commands: store.commands(owner, id),
          messages: store.mail.history(owner, id),
          requests: store.mail.requests(owner, id),
        };
      })
  );
  server.registerTool(
    "side_pocket_send",
    {
      description:
        "Send a follow-up or answer to a Side Pocket by ID. Messages run in order after its current turn. Reuse idempotencyKey when retrying the same send.",
      inputSchema: idSchema.extend({ message: delegationBody, idempotencyKey: delegationKey }),
    },
    ({ id, message, idempotencyKey }) => toolResult(() => delegations().send(owner, id, idempotencyKey, message))
  );
  server.registerTool(
    "side_pocket_answer",
    {
      description:
        "Answer a pending harness question/approval using its request ID from side_pocket_get. For ordinary message_parent questions, reply with side_pocket_send.",
      inputSchema: idSchema.extend({ requestId: z.uuid(), answer: z.record(z.string(), z.unknown()) }),
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
