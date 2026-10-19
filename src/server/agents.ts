import { type AgentTranscript, activeAgent } from "../lib/agents";
import { initialSnapshot, object, string } from "../lib/protocol";
import { discoverAgents } from "./agent-catalog";
import { hydrateAgent } from "./agent-sources";
import { itemImageSources } from "../lib/images";
import { markdownImageSource } from "./agent-images";
import { visibleSnapshot } from "./visible-snapshot";

const REFRESH_MS = 2000;
type Discovery = Awaited<ReturnType<typeof discoverAgents>>;

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

    const agent = {
      ...previous.agent,
      status: activeAgent(previous.agent) ? ("unknown" as const) : previous.agent.status,
    };
    next.records.set(id, { ...previous, agent, historyError: true });
    next.catalog.agents.push(agent);
  }

  return next;
}

// Read-only catalog/transcript cache, scoped to the server-configured parent.
export class AgentBrowser {
  private cached?: Discovery;
  private refreshing?: Promise<void>;
  private async refresh(owner: string) {
    try {
      this.cached = preserveHistory(await discoverAgents(owner), this.cached);
    } finally {
      this.refreshing = undefined;
    }
  }
  private async owned(owner: string, id: string) {
    await this.catalog(owner);
    const record = this.cached?.records.get(id);

    if (!record) {
      throw new Error("Agent is unavailable in this parent chat.");
    }

    return record;
  }
  async catalog(owner: string) {
    if (!this.cached || this.cached.owner !== owner || Date.now() - this.cached.catalog.updatedAt >= REFRESH_MS) {
      this.refreshing ??= this.refresh(owner);
      await this.refreshing;
    }

    if (this.cached?.owner !== owner) {
      throw new Error("Parent chat is unavailable.");
    }

    return this.cached.catalog;
  }
  async transcript(owner: string, id: string): Promise<AgentTranscript> {
    const record = await this.owned(owner, id);
    await hydrateAgent(record);
    const raw = {
      ...structuredClone(initialSnapshot),
      connection: "connected" as const,
      title: record.agent.name,
      model: record.agent.model,
      reasoningEffort: record.agent.reasoningEffort,
      turns: record.turns ?? [],
      requests: record.requests ?? [],
      activeTurnId: activeAgent(record.agent)
        ? record.turns?.findLast((turn) => turn.status === "inProgress")?.id
        : undefined,
    };
    const state = visibleSnapshot(raw, { tools: true });
    // Images use scoped item IDs, never caller-supplied paths or another chat's cache.
    state.turns = state.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      items: turn.items.map((item) => ({
        id: item.id,
        type: item.type,
        ...(typeof item.text === "string" && { text: item.text }),
        ...(item.type === "agentMessage" && {
          imageBase: `/api/agents?agent=${encodeURIComponent(id)}&item=${encodeURIComponent(item.id)}`,
        }),
        ...(typeof item.phase === "string" && { phase: item.phase }),
        ...(Array.isArray(item.content) && {
          content: item.content
            .filter((part) => object(part).type === "text")
            .map((part) => ({ type: "text", text: string(object(part).text) })),
        }),
        ...(item.type === "toolTrace" && { tool: item.tool, status: item.status }),
        ...(Array.isArray(item.images) && {
          images: item.images.map((_, index) => ({
            alt: "Image from Pocket",
            source: `/api/agents?agent=${encodeURIComponent(id)}&item=${encodeURIComponent(item.id)}&index=${index}`,
          })),
        }),
      })),
    }));

    return {
      agent: record.agent,
      state,
      history: record.historyError
        ? "unavailable"
        : state.turns.some((turn) => turn.items.length > 0)
          ? "available"
          : "empty",
      ...(record.historyError && {
        warning: "Saved history is unavailable. Check harness access on your computer. Reconnecting automatically.",
      }),
      updatedAt: Date.now(),
    };
  }
  async image(owner: string, id: string, itemId: string, index: number, markdownSource?: string) {
    const record = await this.owned(owner, id);
    await hydrateAgent(record);
    const item = record.turns?.flatMap((turn) => turn.items).find((entry) => entry.id === itemId);
    const source = item && (markdownSource ? markdownImageSource(item, markdownSource) : itemImageSources(item)[index]);

    if (!source || !Number.isSafeInteger(index) || index < 0) {
      throw new Error("Image is unavailable in this agent chat.");
    }

    return { source, cwd: record.cwd };
  }
}

declare global {
  var pocketAgentBrowser: AgentBrowser | undefined;
}
export function agentBrowser() {
  if (!globalThis.pocketAgentBrowser) {
    Object.defineProperty(globalThis, "pocketAgentBrowser", { value: new AgentBrowser(), configurable: true });
  }

  return globalThis.pocketAgentBrowser as AgentBrowser;
}
