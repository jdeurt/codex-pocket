const ownerBrowsers = new Map<string, AgentBrowser>();

import { type AgentEntry, type AgentTranscript, isActiveAgent } from "../lib/agents";
import { agentImageSource, projectAgentTranscript } from "./agent-projection";
import { AgentReadCache } from "./agent-read-cache";
import { type AgentRecord } from "./agent-sources";
import { discoverAgents } from "./agent-catalog";
import { log } from "./logging";

const REFRESH_MS = 2000;

type Discovery = Awaited<ReturnType<typeof discoverAgents>>;

/**
Retain a verified native child through a source outage without advertising stale active work.
@param next - Current scoped discovery tree receiving the retained child.
@param id - Existing catalog identity whose ancestry remains verified.
@param previous - Previously scoped record containing saved native history.
*/
function retainUnavailableAgent(next: Discovery, id: string, previous: AgentRecord) {
  const agent: AgentEntry = {
    ...previous.agent,
    status: isActiveAgent(previous.agent) ? "unknown" : previous.agent.status,
  };

  next.records.set(id, { ...previous, agent, historyError: true, discoveryError: true });
  next.catalog.agents.push(agent);
}

/**
Retain saved transcripts and verified ancestry when native discovery is temporarily unavailable.
@param next - Fresh scoped discovery result.
@param saved - Previous discovery result reusable only for the same owner.
@returns Discovery retaining known readable history without inventing ownership.
*/
function preserveHistory(next: Discovery, saved?: Discovery) {
  if (saved?.owner !== next.owner) {
    return next;
  }

  for (const [id, record] of next.records) {
    const previous = saved.records.get(id);

    if (!(record.historyError && previous?.turns)) {
      continue;
    }

    record.turns = previous.turns;
    record.agent.preview = previous.agent.preview;
  }

  // Source outages cannot revoke verified ancestry; saved history remains readable.
  for (const [id, previous] of saved.records) {
    const source = previous.agent.harness === "codex" ? "Codex" : "Claude Code";

    if (
      next.records.has(id) ||
      previous.agent.source !== "native" ||
      next.catalog.warnings.every((warning) => !warning.startsWith(source))
    ) {
      continue;
    }

    retainUnavailableAgent(next, id, previous);
  }

  return next;
}

// Read-only catalog/transcript cache, scoped to the server-configured parent.
/**
Own the read-only parent-scoped catalog and native transcript caches.
*/
export class AgentBrowser {
  private reads = new AgentReadCache();

  private cached?: Discovery;

  private refreshing?: Promise<void>;

  /**
Read native discovery and merge still-owned saved history before replacing the catalog.
@param owner - Configured parent whose descendants may be read.
*/
  private async updateDiscovery(owner: string) {
    this.cached = preserveHistory(
      await discoverAgents(owner, this.cached?.owner === owner ? this.cached.records : undefined),
      this.cached
    );
  }

  /**
Refresh scoped discovery while preserving known saved history through source outages.
@param owner - Configured parent whose native descendants may be discovered.
*/
  private async refresh(owner: string) {
    try {
      await this.updateDiscovery(owner);
    } catch (error) {
      if (this.cached?.owner !== owner) {
        throw error;
      }

      log().warn({ err: error, owner }, "agents.discovery_failed");
    } finally {
      this.refreshing = undefined;
    }
  }

  /**
Verify scoped discovery before reading one agent, without projecting every catalog preview.
@param owner - Configured parent identity required by the endpoint.
@param id - Catalog identity requested within that parent.
@returns Owned normalized discovery record.
*/
  private async owned(owner: string, id: string) {
    await this.discovery(owner);

    return this.record(id);
  }

  /**
Require an agent already present in the current scoped discovery cache.
@param id - Catalog identity requested after its owner catalog was refreshed.
@returns Owned discovery record, or an availability error.
*/
  private record(id: string) {
    const record = this.cached?.records.get(id);

    if (!record) {
      throw new Error("Agent is unavailable in this parent chat.");
    }

    return record;
  }

  /**
Require a completed discovery belonging to the configured parent.
@param owner - Parent identity expected by this read.
@returns Current discovery after exact owner validation.
*/
  private requireDiscovery(owner: string) {
    const cached = this.cached;

    if (cached?.owner !== owner) {
      throw new Error("Parent chat is unavailable.");
    }

    return cached;
  }

  /**
Coalesce discovery in the background while serving only a verified same-owner cache.
@param owner - Configured parent whose catalog is being requested.
@returns Completed current discovery for that parent.
*/
  private async discovery(owner: string) {
    if (this.cached?.owner !== owner) {
      await this.refreshing;
      this.refreshing ??= this.refresh(owner);
      await this.refreshing;
    } else if (Date.now() - this.cached.catalog.updatedAt >= REFRESH_MS) {
      this.refreshing ??= this.refresh(owner);
    }

    return this.requireDiscovery(owner);
  }

  /**
Project native revisions and optionally warm previews without dispatching harness work.
@param owner - Configured parent whose descendants alone are visible.
@param isPreviews - Whether background previews should be warmed through the shared pool.
@returns Lightweight scoped catalog with native availability warnings.
*/
  async catalog(owner: string, isPreviews = false) {
    const discovery = await this.discovery(owner);
    const records = discovery.records
      .values()
      .toArray()
      .toSorted((a, b) => Number(isActiveAgent(b.agent)) - Number(isActiveAgent(a.agent)));

    await Promise.all(records.map((record) => this.reads.project(record)));

    if (isPreviews) {
      for (const record of records) {
        void this.reads.warm(record);
      }
    }

    return this.requireDiscovery(owner).catalog;
  }

  /**
Hydrate an owned agent and expose the shared normalized read-only display contract.
@param owner - Configured parent scope.
@param id - Agent identity already present in that parent's discovery.
@returns Read-only transcript with guarded image endpoints and canonical visible rows.
*/
  async transcript(owner: string, id: string): Promise<AgentTranscript> {
    const record = await this.owned(owner, id);

    const isHistoryLoading = await this.reads.full(record);

    return { ...projectAgentTranscript(record, id), isHistoryLoading };
  }

  /**
Read an image only from an owned agent's complete native transcript.
@param owner - Configured parent scope.
@param id - Owned catalog identity.
@param itemId - Native item identity inside that agent's transcript.
@param index - Nonnegative image index requested by the guarded endpoint.
@param markdownSource - Exact optional source authorized against the owned Markdown AST.
@returns Owned source and its native working directory.
*/
  async image(owner: string, id: string, itemId: string, index: number, markdownSource?: string) {
    const record = await this.owned(owner, id);

    await this.reads.full(record, true);

    return agentImageSource(record, itemId, index, markdownSource);
  }
}

declare global {
  var pocketAgentBrowser: AgentBrowser | undefined;
}

/**
Create the process catalog cache while retaining its existing native global descriptor.
@returns The newly registered parent-scoped browser cache.
*/
function createAgentBrowser() {
  const browser = new AgentBrowser();

  Object.defineProperty(globalThis, "pocketAgentBrowser", { value: browser, configurable: true });

  return browser;
}

/** Reuse one independent cache for a verified parent.
@param owner - Verified native parent.
@returns Parent-specific catalog cache.
*/
function ownedBrowser(owner: string) {
  const existing = ownerBrowsers.get(owner);
  const browser = existing ?? new AgentBrowser();

  ownerBrowsers.set(owner, browser);

  return browser;
}

/**
Reuse the process's existing parent-scoped agent browser or create it lazily.
@param owner - Optional verified parent identity for an independent cache.
@returns The process catalog and transcript owner.
*/
export function agentBrowser(owner?: string) {
  return owner ? ownedBrowser(owner) : (globalThis.pocketAgentBrowser ?? createAgentBrowser());
}
