import { readdir, stat } from "node:fs/promises";
import { type AgentRecord } from "./agent-sources";
import { object } from "../lib/protocol";
import os from "node:os";
import path from "node:path";

const roots = new Map<string, Promise<string | undefined>>();

/**
Resolve a candidate project only after its root transcript exists.
@param directory - Native Claude projects directory.
@param project - Name of a verified project subdirectory.
@param root - Validated root session identifier.
@returns Absolute candidate directory after native stat succeeds.
*/
async function existingRoot(directory: string, project: string, root: string) {
  const candidate = path.join(directory, project);

  await stat(/* turbopackIgnore: true */ path.join(candidate, `${root}.jsonl`));

  return candidate;
}

/**
Locate the native Claude project owning a saved root session.
@param directory - Native Claude projects directory.
@param root - Validated root session identifier.
@returns Matching project directory, or undefined when no project owns the root.
*/
async function locateRoot(directory: string, root: string) {
  const entries = await readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      return await existingRoot(directory, entry.name, root);
    } catch {
      /*
      Try the next project.
      */
    }
  }
}

/**
Reuse one pending native root lookup and evict failed or absent projects for later retry.
@param record - Scoped agent whose optional subagent identity is validated.
@param root - Validated saved root session identifier.
@returns Native root or subagent transcript path when the project exists.
*/
async function cachedClaudeFile(record: AgentRecord, root: string) {
  const directory = path.join(
    /* turbopackIgnore: true */ process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects"
  );
  const key = `${directory}:${root}`;

  let pending = roots.get(key);
  let project: string | undefined;

  if (!pending) {
    pending = locateRoot(directory, root);
    roots.set(key, pending);
  }

  try {
    project = await pending;
  } finally {
    if (!project) {
      roots.delete(key);
    }
  }

  return (
    project &&
    (record.claudeAgent
      ? path.join(project, root, "subagents", `agent-${record.claudeAgent}.jsonl`)
      : path.join(project, `${root}.jsonl`))
  );
}

/**
Resolve and coalesce a native Claude session or subagent transcript path.
@param record - Discovered agent with session and subagent identifiers.
@returns Saved JSONL path when its owning project is available.
*/
async function claudeFile(record: AgentRecord) {
  const root = record.claudeRoot ?? record.sessionId;

  if (!root || !/^[\w-]+$/.test(root) || (record.claudeAgent && !/^[\w-]+$/.test(record.claudeAgent))) {
    return;
  }

  return cachedClaudeFile(record, root);
}

/**
Fingerprint a saved transcript using its native modification time and byte length.
@param file - Native transcript path already resolved inside the owning project.
@returns Serialized native timestamp and byte length.
*/
async function transcriptRevision(file: string) {
  const info = await stat(/* turbopackIgnore: true */ file);

  return `${String(info.mtimeMs)}:${String(info.size)}`;
}

/**
Read the native Claude transcript timestamp and byte length when a saved path exists.
@param record - Scoped Claude agent whose root is resolved lazily.
@returns Native file revision, or undefined when no transcript path is available.
*/
async function claudeRevision(record: AgentRecord) {
  const file = await claudeFile(record);

  return file ? transcriptRevision(file) : undefined;
}

/**
Fingerprint discovery metadata and the saved Claude file revision for cache invalidation.
@param record - Discovered record whose file revision is updated after native stat.
@returns Serialized ownership, status, metadata and file-change revision.
*/
export async function agentRevision(record: AgentRecord) {
  let fileRevision: string | undefined;

  if (record.agent.harness === "claude" && record.sessionId) {
    try {
      fileRevision = await claudeRevision(record);
    } catch {
      /*
      The SDK read supplies the user-facing availability state.
      */
    }
  }

  record.fileRevision = fileRevision;
  const owner = record.pocket ?? record.runtimeOwner;
  const writes =
    owner && record.agent.harness === "claude" ? object(JSON.parse(owner.metadata)).claudeWrites : undefined;

  return JSON.stringify({
    parent: record.agent.parentId,
    session: record.sessionId,
    agent: record.claudeAgent,
    cwd: record.cwd,
    updatedAt: record.pocket ? undefined : record.thread?.updatedAt,
    status: record.pocket ? undefined : record.thread?.status,
    pocketUpdatedAt: record.pocket?.updatedAt,
    pocketStatus: record.pocket?.status,
    observedStatus: record.observedStatus,
    fileRevision,
    writes,
  });
}
