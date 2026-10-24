import { t as captureResult } from "try";
import { type Config, configSchema } from "./config";
import { type Thread, object, string } from "../lib/protocol";
import { CodexRpc } from "./rpc";
import { delegationKey } from "./delegation-input";
import { delegations } from "./delegations";
import { z } from "zod";

const PAGE_SIZE = 50;
export const socketPath = z
  .string()
  .startsWith("/")
  .refine((value) => !/[:\r\n\0]/u.test(value), "Invalid socket path");
export const adoptionInput = z
  .object({
    threadId: z.string().min(1),
    title: delegationKey,
    idempotencyKey: delegationKey,
    socketPath: socketPath.optional(),
  })
  .strict();
export const sessionListInput = z
  .object({
    cursor: z.string().optional(),
    archived: z.boolean().default(false),
    search: z.string().optional(),
    socketPath: socketPath.optional(),
  })
  .strict();

export type AdoptionInput = z.infer<typeof adoptionInput>;
export interface AdoptedSession {
  threadId: string;
  cwd: string;
  turnId?: string;
}
export const attachmentSchema = z.object({
  socketPath,
  turnId: z.string().optional(),
  watchCommandId: z.string().optional(),
});

export type SessionAttachment = z.infer<typeof attachmentSchema>;

/**
Read persisted attachment metadata without trusting unchecked JSON fields.
@param metadata - Persisted child metadata.
@returns Validated live attachment, or undefined for ordinary saved children.
*/
export function sessionAttachment(metadata: string) {
  return attachmentSchema.optional().parse(object(JSON.parse(metadata)).attachment);
}

/**
Choose the explicit transport without falling back from an unavailable owner.
@param rpc - Client that will own only this connection.
@param config - Native launch configuration for saved history.
@param filename - Existing owner's socket, when supplied.
@returns Completion of native initialization.
*/
function connectSession(rpc: CodexRpc, config: Config, filename?: string) {
  return filename ? rpc.connectSocket(socketPath.parse(filename)) : rpc.connect(config, "bare");
}

/**
Connect to saved history or to the explicitly selected owning server.
@param config - Native account and binary configuration.
@param filename - Existing server's local socket, when attaching live.
@returns Initialized client; the caller must shut it down.
*/
export async function sessionClient(config: Config, filename?: string) {
  const rpc = new CodexRpc();

  const connected = await captureResult(connectSession, rpc, config, filename);

  if (connected.ok) {
    return rpc;
  }

  await rpc.shutdown();
  throw connected.error;
}

/**
Require the selected thread to already be loaded by the specified owner.
@param rpc - Connection to the owning server.
@param threadId - Existing session to attach without loading a saved copy.
*/
export async function requireLoadedSession(rpc: CodexRpc, threadId: string) {
  let cursor: string | null = null;

  do {
    const page = z
      .object({ data: z.array(z.string()), nextCursor: z.string().nullable() })
      .parse(await rpc.request("thread/loaded/list", { cursor, limit: PAGE_SIZE }));

    if (page.data.includes(threadId)) {
      return;
    }

    cursor = page.nextCursor;
  } while (cursor);

  throw new Error("That server does not own a loaded session with this ID. No saved copy was resumed.");
}

/**
Reject active saved copies and retain the exact native identity and working folder.
@param thread - Native persisted or loaded session.
@param isLive - Whether the caller selected the owning server.
@returns Metadata needed for durable adoption.
*/
function inspectedSession(thread: Thread, isLive: boolean): AdoptedSession {
  const active = thread.turns.findLast((turn) => turn.status === "inProgress");
  const cwd = string(thread.cwd);

  if (!cwd.startsWith("/")) {
    throw new Error("The existing session has no absolute working directory.");
  }

  if (!isLive && (active || object(thread.status).type === "active")) {
    throw new Error("This session may still be running. Supply its owning app-server socketPath to attach live.");
  }

  return { threadId: thread.id, cwd, ...(active && { turnId: active.id }) };
}

/**
Read the exact native session after any owning-server check has completed.
@param rpc - Connected native client.
@param input - Validated session identity.
@returns Inspected native identity and active turn.
*/
async function readAdoption(rpc: CodexRpc, input: AdoptionInput) {
  const { thread } = await rpc.request("thread/read", { threadId: input.threadId, includeTurns: true });

  if (thread.id !== input.threadId) {
    throw new Error("Codex returned a different session identity.");
  }

  return inspectedSession(thread, !!input.socketPath);
}

/**
Verify ownership before reading a live session, without loading another copy.
@param rpc - Connected native client.
@param input - Validated session identity and optional owner endpoint.
@returns Native adoption metadata.
*/
async function inspectSession(rpc: CodexRpc, input: AdoptionInput) {
  if (input.socketPath) {
    await requireLoadedSession(rpc, input.threadId);
  }

  return readAdoption(rpc, input);
}

/** Own a temporary native client for one explicit query, including failure cleanup.
@param config - Native account configuration.
@param input - Query data and optional owning socket.
@param query - Module-scope query implementation.
@returns Query result after the client has shut down.
*/
async function adoptionQuery<Input extends { socketPath?: string }, Output>(
  config: Config,
  input: Input,
  query: (rpc: CodexRpc, input: Input) => Promise<Output>
) {
  const rpc = await sessionClient(config, input.socketPath);
  const completed = await captureResult(query, rpc, input);

  await rpc.shutdown();

  if (!completed.ok) {
    throw completed.error;
  }

  return completed.value;
}

/**
Inspect a session before adding tracking, without sending input or resuming a saved copy.
@param config - Native account configuration.
@param input - Validated exact session and optional owner endpoint.
@returns Canonical native adoption metadata.
*/
export async function inspectAdoption(config: Config, input: AdoptionInput) {
  return adoptionQuery(config, input, inspectSession);
}

/**
Read saved session summaries without loading any of them.
@param rpc - Connected native client.
@param input - Pagination and search options.
@returns Bounded native session summaries.
*/
async function savedSessions(rpc: CodexRpc, input: z.infer<typeof sessionListInput>) {
  const page = await rpc.request("thread/list", {
    cursor: input.cursor,
    limit: PAGE_SIZE,
    archived: input.archived,
    searchTerm: input.search,
    sourceKinds: [],
  });

  return {
    ...page,
    data: page.data.map((thread) => ({
      id: thread.id,
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      status: thread.status,
    })),
  };
}

/**
Select loaded-session discovery for a live owner and saved discovery otherwise.
@param rpc - Initialized client.
@param input - Native pagination and connection selection.
@returns Native session page.
*/
function sessionPage(rpc: CodexRpc, input: z.infer<typeof sessionListInput>) {
  return input.socketPath
    ? rpc.request("thread/loaded/list", { cursor: input.cursor, limit: PAGE_SIZE })
    : savedSessions(rpc, input);
}

/**
Discover saved sessions with previews, or only sessions loaded by a selected server.
@param config - Native account configuration.
@param input - Pagination and optional owning socket.
@returns One bounded page of native session summaries.
*/
export async function listAdoptableSessions(config: Config, input: z.infer<typeof sessionListInput>) {
  return adoptionQuery(config, input, sessionPage);
}

/**
Read the parent-scoped launcher configuration passed explicitly to the MCP process.
@param owner - Verified parent identity from the native MCP launcher.
@returns Configuration using the same binary and working folder as the parent.
*/
export function adoptionConfig(owner: string) {
  const serverArgs: unknown = process.env.POCKET_CODEX_SERVER_ARGS
    ? JSON.parse(process.env.POCKET_CODEX_SERVER_ARGS)
    : undefined;

  return configSchema.parse({
    threadId: owner,
    cwd: delegations().parent(owner).cwd,
    codexBinary: process.env.POCKET_CODEX_BINARY ?? "codex",
    serverArgs,
  });
}
