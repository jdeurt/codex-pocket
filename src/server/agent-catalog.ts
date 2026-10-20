import {
  type AgentRecord,
  type CodexThread,
  codexParent,
  codexThreads,
  informationalRequest,
  observeCodex,
  observedMetadata,
} from "./agent-sources";
import { type AgentStatus, agentStatusSchema, isActiveAgent } from "../lib/agents";
import { type SidePocket, delegations } from "./delegations";
import { claudeChildren, observeClaudeChild } from "./agent-claude";
import { object, string } from "../lib/protocol";
import { readConfig } from "./config";

/**
Normalize a persisted Side Pocket into a read-only discovery record.
@param child - Validated persisted child and parent policy.
@param id - Catalog identity chosen after native-session deduplication.
@param parentId - Catalog identity of its owning parent.
@returns Scoped record with saved metadata and informational pending requests.
*/
function pocketRecord(child: SidePocket, id: string, parentId: string): AgentRecord {
  const metadata = object(JSON.parse(child.metadata));
  const lastStatus = delegations().lastCommandStatus(child.parentId, child.id);

  let status: AgentStatus = ["running", "waiting", "idle", "closed"].includes(child.status)
    ? agentStatusSchema.parse(child.status)
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

/**
Insert a deduplicated saved child and expose its native and persisted identities for descendant discovery.
@param tree - Discovery maps receiving this owned child.
@param child - Validated persisted Side Pocket.
@param parent - Reachable native or persisted parent identity.
@param key - Exact native-session identity already checked for duplicate ownership.
@param existingId - Prior native catalog identity, when one already exists.
@returns Newly attached normalized discovery record.
*/
function insertPocket(
  tree: DiscoveryTree,
  child: SidePocket,
  parent: string,
  key: string,
  existingId: string | undefined
) {
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

  return record;
}

/**
Attach a saved child once while retaining native-session and parent ownership.
@param tree - Discovery maps and reachable parent identities.
@param child - Persisted child encountered beneath a reachable parent.
@param parent - Native or persisted parent identity being scanned.
@returns Newly attached record, or undefined when its identity is already owned.
*/
function attachPocket(tree: DiscoveryTree, child: SidePocket, parent: string) {
  const key = `${child.harness}:${child.sessionId ?? `pocket:${child.id}`}`;
  const existingId = tree.sessions.get(key);

  if (existingId === tree.owner) {
    return;
  }

  if (existingId && tree.records.get(existingId)?.pocket) {
    return;
  }

  return insertPocket(tree, child, parent, key, existingId);
}

/**
Attach saved children beneath a snapshot of the currently reachable parents.
@param tree - Discovery maps whose reachable parent set may expand.
@param scanned - Parent identities whose persisted children have already been scanned.
@returns Whether at least one saved child expanded the tree.
*/
function didAttachSavedChildren(tree: DiscoveryTree, scanned: Set<string>) {
  const pendingParents = tree.parents.values().toArray();

  let hasProgress = false;

  for (const parent of pendingParents) {
    if (scanned.has(parent)) {
      continue;
    }

    scanned.add(parent);

    for (const child of delegations().list(parent)) {
      if (attachPocket(tree, child, parent)) {
        hasProgress = true;
      }
    }
  }

  return hasProgress;
}

/**
Attach one native Codex descendant after its parent and session ownership have been checked.
@param tree - Scoped discovery maps receiving the native identity.
@param thread - Native child thread returned by lightweight discovery.
@param parentId - Already discovered parent catalog identity.
@param cwd - Configured parent directory used only when native metadata omits it.
*/
function attachNativeThread(tree: DiscoveryTree, thread: CodexThread, parentId: string, cwd: string) {
  const id = `codex:${thread.id}`;

  tree.records.set(id, {
    agent: {
      id,
      parentId,
      name: string(thread.name) || string(thread.agentNickname) || string(thread.agentRole) || "Agent",
      source: "native",
      harness: "codex",
      status: "unknown",
      preview: "",
    },
    cwd: string(thread.cwd) || cwd,
    sessionId: thread.id,
    thread,
    runtimeOwner: tree.records.get(parentId)?.pocket ?? tree.records.get(parentId)?.runtimeOwner,
  });
  tree.sessions.set(`codex:${thread.id}`, id);
  tree.parents.add(thread.id);
}

/**
Retain native discovery outages as catalog warnings without revoking saved ownership.
@param warnings - Catalog warnings receiving a native availability failure.
@returns Lightweight native child threads, or an empty list while discovery is unavailable.
*/
async function availableCodexThreads(warnings: string[]) {
  try {
    return await codexThreads();
  } catch {
    warnings.push("Codex discovery is unavailable. Reconnecting automatically.");

    return [];
  }
}

/**
Attach Claude descendants using SDK ancestry and observed parent-owned metadata.
@param record - Discovered Claude root whose descendants are scoped to this owner.
@param previous - Prior records available for saved ancestry reuse.
@param records - Catalog records receiving normalized native children.
*/
async function attachClaudeChildren(
  record: AgentRecord,
  previous: Map<string, AgentRecord>,
  records: Map<string, AgentRecord>
) {
  const children = await claudeChildren(record, previous);

  for (const child of children) {
    observeClaudeChild(record, child);
    records.set(child.agent.id, child);
  }
}

/**
Observe discovered native roots and read Claude ancestry after saved and Codex discovery settles.
@param tree - Complete saved and Codex ownership tree.
@param previous - Prior scoped records available for Claude ancestry reuse.
@param warnings - Catalog warnings receiving native Claude availability failures.
*/
async function discoverClaude(tree: DiscoveryTree, previous: Map<string, AgentRecord>, warnings: string[]) {
  const roots = tree.records.values().toArray();

  for (const record of roots) {
    if (record.agent.harness === "codex") {
      observeCodex(record);
    }

    if (record.agent.harness !== "claude") {
      continue;
    }

    try {
      await attachClaudeChildren(record, previous, tree.records);
    } catch {
      warnings.push("Claude Code agent discovery is unavailable.");
    }
  }
}

/**
Build the configured parent's ownership tree before projecting the lightweight catalog.
@param owner - Configured parent whose descendants alone are reachable.
@param cwd - Parent working directory retained when native metadata omits it.
@param previous - Previous discovery records used only for established ancestry reuse.
@returns Scoped ownership records and the existing active-first catalog presentation.
*/
async function discoverConfigured(owner: string, cwd: string, previous: Map<string, AgentRecord>) {
  const records = new Map<string, AgentRecord>();
  const sessions = new Map<string, string>([[`codex:${owner}`, owner]]);
  const parents = new Set([owner]);
  const tree = { owner, records, sessions, parents };
  const scanned = new Set<string>();
  const warnings: string[] = [];
  const native = await availableCodexThreads(warnings);

  let hasProgress = true;

  while (hasProgress) {
    hasProgress = didAttachSavedChildren(tree, scanned);

    for (const thread of native) {
      const parentId = sessions.get(`codex:${codexParent(thread)}`);

      if (!parentId || sessions.has(`codex:${thread.id}`)) {
        continue;
      }

      attachNativeThread(tree, thread, parentId, cwd);
      hasProgress = true;
    }
  }

  await discoverClaude(tree, previous, warnings);

  return {
    owner,
    records,
    catalog: {
      agents: records
        .values()
        .map((record) => record.agent)
        .toArray()
        .toSorted((a, b) => Number(isActiveAgent(b)) - Number(isActiveAgent(a)) || a.name.localeCompare(b.name)),
      warnings: [...new Set(warnings)],
      updatedAt: Date.now(),
    },
  };
}

/**
Discover only configured-parent descendants and merge native and saved identities.
@param owner - Configured parent thread owning this read-only catalog.
@param previous - Previous discovery records available for native child reuse.
@returns Scoped records and a sorted lightweight catalog with availability warnings.
*/
export async function discoverAgents(owner: string, previous = new Map<string, AgentRecord>()) {
  const config = await readConfig();

  if (config?.threadId !== owner) {
    throw new Error("Parent chat is unavailable.");
  }

  return discoverConfigured(owner, config.cwd, previous);
}
