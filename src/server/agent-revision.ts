import { readdir, stat } from "node:fs/promises";
import { type AgentRecord } from "./agent-sources";
import os from "node:os";
import path from "node:path";

const roots = new Map<string, Promise<string | undefined>>();

async function locateRoot(directory: string, root: string) {
  for (const entry of await readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidate = path.join(directory, entry.name);

    try {
      await stat(/* turbopackIgnore: true */ path.join(candidate, `${root}.jsonl`));

      return candidate;
    } catch {
      /*
      Try the next project.
      */
    }
  }
}

async function claudeFile(record: AgentRecord) {
  const root = record.claudeRoot ?? record.sessionId;

  if (!root || !/^[\w-]+$/.test(root) || (record.claudeAgent && !/^[\w-]+$/.test(record.claudeAgent))) {
    return;
  }

  const directory = path.join(
    /* turbopackIgnore: true */ process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "projects"
  );
  const key = `${directory}:${root}`;

  let pending = roots.get(key);

  if (!pending) {
    pending = locateRoot(directory, root);
    roots.set(key, pending);
  }

  let project: string | undefined;

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

export async function agentRevision(record: AgentRecord) {
  let fileRevision: string | undefined;

  if (record.agent.harness === "claude" && record.sessionId) {
    try {
      const file = await claudeFile(record);

      if (file) {
        const info = await stat(/* turbopackIgnore: true */ file);

        fileRevision = `${String(info.mtimeMs)}:${String(info.size)}`;
      }
    } catch {
      /*
      The SDK read supplies the user-facing availability state.
      */
    }
  }

  record.fileRevision = fileRevision;

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
  });
}
