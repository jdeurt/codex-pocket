import {
  type AdoptionInput,
  adoptionConfig,
  adoptionInput,
  inspectAdoption,
  listAdoptableSessions,
  sessionAttachment,
  sessionListInput,
} from "../src/server/session-adoption";
import { type McpServer } from "@modelcontextprotocol/server";
import { delegations } from "../src/server/delegations";
import { toolResult } from "../src/server/mcp-result";

/**
Inspect the native session before committing its durable ownership.
@param owner - Parent identity.
@param input - Validated adoption request.
@returns Adopted child without replayed input.
*/
async function adoptSession(owner: string, input: AdoptionInput) {
  const session = await inspectAdoption(adoptionConfig(owner), input);

  return delegations().adoptions.adopt(owner, input, session);
}

/**
Perform native inspection before an atomic tracking-only reconnect.
@param owner - Authorized parent identity.
@param id - Existing delegate ID.
@param input - Exact native session and original socket.
@returns Resumed delegate with its current native turn tracked.
*/
async function reconnectSidePocket(owner: string, id: string, input: AdoptionInput) {
  const session = await inspectAdoption(adoptionConfig(owner), input);

  return delegations().adoptions.reconnect(owner, id, session);
}

/**
Inspect the original owner before reconnecting a detached or uncertain live delegate.
@param owner - Authorized parent identity.
@param id - Existing delegate ID.
@returns Resumed tracking, never a replayed assignment.
*/
export async function resumeSidePocket(owner: string, id: string) {
  const store = delegations();
  const child = store.get(owner, id);
  const attachment = sessionAttachment(child.metadata);

  return attachment && child.sessionId
    ? reconnectSidePocket(owner, id, {
        threadId: child.sessionId,
        title: child.title,
        idempotencyKey: child.createKey,
        socketPath: attachment.socketPath,
      })
    : store.resume(owner, id);
}

/**
Expose saved-session discovery and explicit native adoption to the authorized parent.
@param server - Parent's native MCP server.
@param owner - Parent identity authorizing delegate ownership.
*/
export function registerAdoptionTools(server: McpServer, owner: string) {
  server.registerTool(
    "side_pocket_sessions",
    {
      description:
        "Find existing Codex sessions with IDs, names, previews and working folders. Pass socketPath to list sessions loaded by an existing local app-server instead of saved history. Results are paginated. Discovery does not resume sessions.",
      inputSchema: sessionListInput,
    },
    (input) => toolResult(async () => listAdoptableSessions(adoptionConfig(owner), input))
  );
  server.registerTool(
    "side_pocket_adopt",
    {
      description:
        "Hook an existing Codex session into this parent's Side Pockets without copying history or sending an assignment. Supply its threadId, title and stable idempotencyKey. For a saved session, first stop using it in the other window; thread ID alone cannot attach to an active process. To follow a running session, supply the absolute Unix socketPath of its owning app-server. Pocket observes that turn and reports its result. Live permissions and approvals remain with the owner; closing the Side Pocket only detaches. Later side_pocket_send uses the same owner. An unavailable owner fails explicitly, with no saved-copy fallback. Already managed sessions and main Pocket sessions cannot be adopted again.",
      inputSchema: adoptionInput,
    },
    (input) =>
      toolResult(async () => {
        const store = delegations();
        const existing = store.adoptions.existing(owner, input);

        return existing ?? adoptSession(owner, input);
      })
  );
}
