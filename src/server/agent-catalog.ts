import { t } from "try";
import { type AgentRecord, codexParent, codexThreads, informationalRequest, observeCodex } from "./agent-sources";
import { delegations } from "./delegations";
import { claudeChildren, observeClaudeChild } from "./agent-claude";
import { configForOwner } from "./pocket-config";
import { attachPocket, attachNativeThread, type DiscoveryTree } from "../state/agent-tree";
import { catalogAgent, compareCatalogAgents } from "../state/agent-discovery";
import { log } from "./logging";

/** Read saved children once for each reachable parent.
@param tree - Current verified ownership tree.
@param scanned - Parent identities read in this discovery pass.
@returns New tree and set of scanned parents.
*/
function savedChildren(tree: DiscoveryTree, scanned: Set<string>) {
  const nextScanned = new Set(scanned);
  const store = delegations();

  let next = tree;

  for (const parent of tree.parents) {
    if (scanned.has(parent)) {
      continue;
    }

    nextScanned.add(parent);

    for (const child of store.list(parent)) {
      const requests = Array.from(store.mail.requests(child.parentId, child.id, true), informationalRequest);

      next = attachPocket(next, child, parent, store.lastCommandStatus(child.parentId, child.id), requests);
    }
  }

  return { tree: next, scanned: nextScanned };
}

/** Read Claude ancestry and retain explicit source outages.
@param tree - Verified saved and Codex ancestry.
@param previous - Prior records available for ancestry reuse.
@returns Independent native records and source warnings.
*/
async function nativeRecords(tree: DiscoveryTree, previous: Map<string, AgentRecord>) {
  const records = new Map<string, AgentRecord>();
  const warnings: string[] = [];

  for (const source of tree.records.values()) {
    const record = source.agent.harness === "codex" ? observeCodex(source) : source;

    records.set(record.agent.id, { ...record, owner: tree.owner });

    if (record.agent.harness !== "claude") {
      continue;
    }

    const children = await t(claudeChildren, record, previous);

    if (!children.ok) {
      warnings.push("Claude Code agent discovery is unavailable.");
      log().warn({ err: children.error, agent: record.agent.id }, "agents.discovery_failed");
      continue;
    }

    for (const child of children.value) {
      records.set(child.agent.id, { ...observeClaudeChild(record, child), owner: tree.owner });
    }
  }

  return { records, warnings };
}

/** Discover verified descendants without mutating cached records.
@param owner - Configured parent whose descendants are visible.
@param previous - Prior verified discovery records.
@returns Scoped records and native availability warnings.
*/
export async function discoverAgents(owner: string, previous = new Map<string, AgentRecord>()) {
  const config = await configForOwner(owner);

  if (config.threadId !== owner) {
    throw new Error("Parent chat is unavailable.");
  }

  const native = await t(codexThreads, owner);
  const warnings: string[] = [];

  if (!native.ok) {
    warnings.push("Codex discovery is unavailable. Reconnecting automatically.");
    log().warn({ err: native.error, owner }, "agents.discovery_failed");
  }

  const threads = native.ok ? native.value : [];

  let tree: DiscoveryTree = {
    owner,
    records: new Map(),
    sessions: new Map([[`codex:${owner}`, owner]]),
    parents: new Set([owner]),
  };
  let scanned = new Set<string>();
  let hasProgress = true;

  while (hasProgress) {
    const saved = savedChildren(tree, scanned);

    hasProgress = saved.tree !== tree;
    tree = saved.tree;
    scanned = saved.scanned;

    for (const thread of threads) {
      const parentId = tree.sessions.get(`codex:${codexParent(thread)}`);

      if (!parentId || tree.sessions.has(`codex:${thread.id}`)) {
        continue;
      }

      tree = attachNativeThread(tree, thread, parentId, config.cwd);
      hasProgress = true;
    }
  }

  const discovered = await nativeRecords(tree, previous);

  return {
    owner,
    records: discovered.records,
    catalog: {
      agents: Array.from(discovered.records.values(), catalogAgent).toSorted(compareCatalogAgents),
      warnings: [...new Set([...warnings, ...discovered.warnings])],
      updatedAt: Date.now(),
    },
  };
}
