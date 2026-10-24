import { type AgentRecord, type CodexThread, observedMetadata } from "./agent-metadata";
import type { SidePocket } from "../server/delegations";
import { type AgentStatus, agentStatusSchema } from "../lib/agents";
import { type PendingRequest, object, string } from "../lib/protocol";

/**
Normalize a persisted Side Pocket into a read-only discovery record.
@param child - Validated persisted child and parent policy.
@param id - Catalog identity chosen after native-session deduplication.
@param parentId - Catalog identity of its owning parent.
@returns Scoped record with saved metadata and informational pending requests.
@param lastStatus - Latest persisted command status.
@param requests - Saved informational requests.
*/
function pocketRecord(
  child: SidePocket,
  id: string,
  parentId: string,
  lastStatus: string | undefined,
  requests: PendingRequest[]
): AgentRecord {
  const metadata = object(JSON.parse(child.metadata));

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
    requests,
  };
}

export interface DiscoveryTree {
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
@param lastStatus - Latest persisted command status.
@param requests - Saved informational requests.
*/
function insertPocket(
  tree: DiscoveryTree,
  child: SidePocket,
  parent: string,
  key: string,
  existingId: string | undefined,
  lastStatus: string | undefined,
  requests: PendingRequest[]
) {
  const id = existingId && tree.records.has(existingId) ? existingId : `pocket:${child.id}`;
  const record = pocketRecord(
    child,
    id,
    tree.sessions.get(`codex:${parent}`) ?? tree.sessions.get(`claude:${parent}`) ?? parent,
    lastStatus,
    requests
  );

  return {
    ...tree,
    records: new Map(tree.records).set(id, record),
    sessions: new Map(tree.sessions).set(key, id).set(`${child.harness}:${child.id}`, id),
    parents: new Set([...tree.parents, child.id, ...(child.sessionId ? [child.sessionId] : [])]),
  };
}

/**
Attach a saved child once while retaining native-session and parent ownership.
@param tree - Discovery maps and reachable parent identities.
@param child - Persisted child encountered beneath a reachable parent.
@param parent - Native or persisted parent identity being scanned.
@returns Newly attached record, or undefined when its identity is already owned.
@param lastStatus - Latest persisted command status.
@param requests - Saved informational requests.
*/
export function attachPocket(
  tree: DiscoveryTree,
  child: SidePocket,
  parent: string,
  lastStatus: string | undefined,
  requests: PendingRequest[]
) {
  const key = `${child.harness}:${child.sessionId ?? `pocket:${child.id}`}`;
  const existingId = tree.sessions.get(key);

  if (existingId === tree.owner) {
    return tree;
  }

  return existingId && tree.records.get(existingId)?.pocket
    ? tree
    : insertPocket(tree, child, parent, key, existingId, lastStatus, requests);
}

/**
Attach one native Codex descendant after its parent and session ownership have been checked.
@param tree - Scoped discovery maps receiving the native identity.
@param thread - Native child thread returned by lightweight discovery.
@param parentId - Already discovered parent catalog identity.
@param cwd - Configured parent directory used only when native metadata omits it.
@returns New tree including the native descendant.
*/
export function attachNativeThread(tree: DiscoveryTree, thread: CodexThread, parentId: string, cwd: string) {
  const id = `codex:${thread.id}`;

  const record: AgentRecord = {
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
  };

  return {
    ...tree,
    records: new Map(tree.records).set(id, record),
    sessions: new Map(tree.sessions).set(`codex:${thread.id}`, id),
    parents: new Set([...tree.parents, thread.id]),
  };
}
