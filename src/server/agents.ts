import { t as captureResult } from "try";

const ownerBrowsers = new Map<string, AgentBrowser>();

import { type AgentTranscript } from "../lib/agents";
import { agentImageSource, projectAgentTranscript } from "./agent-projection";
import { AgentReadCache } from "./agent-read-cache";
import { type AgentRecord } from "./agent-sources";
import { catalogAgent, compareCatalogAgents, preserveHistory } from "../state/agent-discovery";

type Discovery = Awaited<ReturnType<typeof discoverAgents>>;
import { discoverAgents } from "./agent-catalog";
import { log } from "./logging";

const REFRESH_MS = 2000;

// Read-only catalog/transcript cache, scoped to the server-configured parent.
/**
Own the read-only parent-scoped catalog and native transcript caches.
*/
export class AgentBrowser {
  private reads = new AgentReadCache();

  private cached?: Discovery;

  private refreshing?: Promise<void>;

  /** Report background preview failures without rejecting an unobserved promise.
  @param record - Scoped preview source.
  */
  private async warm(record: AgentRecord) {
    const result = await captureResult(this.reads.warm.bind(this.reads), record);

    if (!result.ok) {
      log().warn({ err: result.error, agent: record.agent.id }, "agents.preview_failed");
    }
  }

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
    const refreshed = await captureResult(this.updateDiscovery.bind(this), owner);

    this.refreshing = undefined;

    if (refreshed.ok) {
      return;
    }

    if (this.cached?.owner !== owner) {
      throw refreshed.error;
    }

    log().warn({ err: refreshed.error, owner }, "agents.discovery_failed");
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
    const records = await Promise.all(Array.from(discovery.records.values(), this.reads.project.bind(this.reads)));

    if (isPreviews) {
      for (const record of records) {
        void this.warm(record);
      }
    }

    return { ...discovery.catalog, agents: Array.from(records, catalogAgent).toSorted(compareCatalogAgents) };
  }

  /**
Hydrate an owned agent and expose the shared normalized read-only display contract.
@param owner - Configured parent scope.
@param id - Agent identity already present in that parent's discovery.
@returns Read-only transcript with guarded image endpoints and canonical visible rows.
*/
  async transcript(owner: string, id: string): Promise<AgentTranscript> {
    const record = await this.owned(owner, id);

    const loaded = await this.reads.full(record);

    return { ...projectAgentTranscript(loaded.record, id, Date.now()), isHistoryLoading: loaded.isHistoryLoading };
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

    const loaded = await this.reads.full(record, true);

    return agentImageSource(loaded.record, itemId, index, markdownSource);
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
