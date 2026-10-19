import {
  type AgentRecord,
  type CodexThread,
  claudeChildren,
  codexParent,
  codexThreads,
  informationalRequest,
  observeClaudeChild,
  observeCodex,
  observedMetadata,
} from "./agent-sources";
import { type AgentStatus, activeAgent } from "../lib/agents";
import { type SidePocket, delegations } from "./delegations";
import { object, string } from "../lib/protocol";
import { readConfig } from "./config";

function pocketRecord(child: SidePocket, id: string, parentId: string): AgentRecord {
  const metadata = object(JSON.parse(child.metadata));
  const lastStatus = delegations().lastCommandStatus(child.parentId, child.id);
  let status: AgentStatus = ["running", "waiting", "idle", "closed"].includes(child.status)
    ? (child.status as AgentStatus)
    : "unknown";

  if (status === "idle" && lastStatus === "failed") {
    status = "failed";
  }

  return {
    agent: {
      id,
      parentId: parentId,
      name: child.title,
      source: "side-pocket",
      harness: child.harness,
      status,
      preview: "",
      ...observedMetadata(metadata),
    },
    pocket: child,
    cwd: child.cwd,
    sessionId: child.sessionId ?? undefined,
    requests: delegations()
      .mail.requests(child.parentId, child.id, true)
      .map((request) => informationalRequest(request)),
  };
}

interface DiscoveryTree {
  owner: string;
  records: Map<string, AgentRecord>;
  sessions: Map<string, string>;
  parents: Set<string>;
}

function attachPocket(tree: DiscoveryTree, child: SidePocket, parent: string) {
  const key = `${child.harness}:${child.sessionId ?? `pocket:${child.id}`}`;
  const existingId = tree.sessions.get(key);

  if (existingId === tree.owner) {
    return false;
  }

  if (existingId && tree.records.get(existingId)?.pocket) {
    return false;
  }

  const id = existingId && tree.records.has(existingId) ? existingId : `pocket:${child.id}`;
  const record = pocketRecord(
    child,
    id,
    tree.sessions.get(`codex:${parent}`) ?? tree.sessions.get(`claude:${parent}`) ?? parent
  );
  tree.records.set(id, record);
  tree.sessions.set(key, id);
  tree.sessions.set(`${child.harness}:${child.id}`, id);
  tree.parents.add(child.id);

  if (child.sessionId) {
    tree.parents.add(child.sessionId);
  }

  return true;
}

export async function discoverAgents(owner: string, previous = new Map<string, AgentRecord>()) {
  const config = await readConfig();

  if (!config || config.threadId !== owner) {
    throw new Error("Parent chat is unavailable.");
  }

  const records = new Map<string, AgentRecord>();
  const sessions = new Map<string, string>([[`codex:${owner}`, owner]]);
  const parents = new Set([owner]);
  const tree = { owner, records, sessions, parents };
  const scanned = new Set<string>();
  const warnings: string[] = [];
  let native: CodexThread[] = [];

  try {
    native = await codexThreads();
  } catch {
    warnings.push("Codex discovery is unavailable. Reconnecting automatically.");
  }

  let progress = true;

  while (progress) {
    progress = false;

    const pendingParents = parents.values().toArray();

    for (const parent of pendingParents) {
      if (scanned.has(parent)) {
        continue;
      }

      scanned.add(parent);

      for (const child of delegations().list(parent)) {
        progress = attachPocket(tree, child, parent) || progress;
      }
    }

    for (const thread of native) {
      const parentId = sessions.get(`codex:${codexParent(thread)}`);

      if (!parentId || sessions.has(`codex:${thread.id}`)) {
        continue;
      }

      const id = `codex:${thread.id}`;
      records.set(id, {
        agent: {
          id,
          parentId,
          name: string(thread.name) || string(thread.agentNickname) || string(thread.agentRole) || "Agent",
          source: "native",
          harness: "codex",
          status: "unknown",
          preview: "",
        },
        cwd: string(thread.cwd) || config.cwd,
        sessionId: thread.id,
        thread,
        runtimeOwner: records.get(parentId)?.pocket ?? records.get(parentId)?.runtimeOwner,
      });
      sessions.set(`codex:${thread.id}`, id);
      parents.add(thread.id);
      progress = true;
    }
  }

  const roots = records.values().toArray();

  for (const record of roots) {
    if (record.agent.harness === "codex") {
      observeCodex(record);
    }

    if (record.agent.harness !== "claude") {
      continue;
    }

    try {
      const children = await claudeChildren(record, previous);

      for (const child of children) {
        observeClaudeChild(record, child);
        records.set(child.agent.id, child);
      }
    } catch {
      warnings.push("Claude Code agent discovery is unavailable.");
    }
  }

  return {
    owner,
    records,
    catalog: {
      agents: records
        .values()
        .map((record) => record.agent)
        .toArray()
        .sort((a, b) => Number(activeAgent(b)) - Number(activeAgent(a)) || a.name.localeCompare(b.name)),
      warnings: [...new Set(warnings)],
      updatedAt: Date.now(),
    },
  };
}
