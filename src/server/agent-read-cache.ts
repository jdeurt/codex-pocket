import { type AgentRecord, hydrateAgent, nativeStatus, observedMetadata } from "./agent-sources";
import { type Turn } from "../lib/protocol";
import { isActiveAgent } from "../lib/agents";
import { agentRead } from "./agent-read-pool";
import { agentRevision } from "./agent-revision";
import { bridge } from "./bridge";
import { codexPreview } from "./agent-history";

const LIVE_REFRESH_MS = 2000;
const MAX_TRANSCRIPTS = 12;

interface CachedRead {
  revision: string;
  at: number;
  agent: AgentRecord["agent"];
  turns?: Turn[];
  historyError?: boolean;
}

export class AgentReadCache {
  private selected = "";

  private previews = new Map<string, CachedRead>();

  private transcripts = new Map<string, CachedRead>();

  private pending = new Map<string, Promise<void>>();

  private fresh(record: AgentRecord, saved: CachedRead | undefined, revision: string, isImage = false) {
    return (
      saved?.revision === revision &&
      (!saved.historyError || Date.now() - saved.at < LIVE_REFRESH_MS) &&
      (isImage ||
        (record.agent.harness === "claude" && Boolean(record.fileRevision)) ||
        ["idle", "completed", "failed", "closed"].includes(record.agent.status) ||
        Date.now() - saved.at < LIVE_REFRESH_MS)
    );
  }

  private apply(record: AgentRecord, saved: CachedRead) {
    Object.assign(record.agent, {
      ...observedMetadata({ model: saved.agent.model, effort: saved.agent.reasoningEffort }),
      preview: saved.agent.preview,
      previewState: saved.agent.previewState,
    });

    if (
      !record.pocket &&
      ["idle", "unknown"].includes(record.agent.status) &&
      ["completed", "failed", "closed"].includes(saved.agent.status)
    ) {
      record.agent.status = saved.agent.status;
    }

    if (saved.turns) {
      record.turns = saved.turns;
    }

    record.historyError = record.discoveryError === true ? true : saved.historyError;
  }

  private remember(record: AgentRecord, revision: string, isFull: boolean) {
    record.agent.previewState = record.historyError ? "unavailable" : record.agent.preview ? undefined : "empty";
    const value: CachedRead = {
      revision,
      at: Date.now(),
      agent: { ...record.agent },
      historyError: record.historyError,
      ...(isFull && { turns: record.turns ?? [] }),
    };

    this.previews.set(record.agent.id, { ...value, turns: undefined });

    if (!isFull) {
      return;
    }

    this.transcripts.delete(record.agent.id);
    this.transcripts.set(record.agent.id, value);

    while (this.transcripts.size > MAX_TRANSCRIPTS) {
      const oldest = this.transcripts.keys().find((id) => id !== this.selected);

      if (oldest) {
        this.transcripts.delete(oldest);
      }
    }
  }

  private async readFull(record: AgentRecord, revision: string, priority: number) {
    const saved = this.transcripts.get(record.agent.id);

    if (saved) {
      this.apply(record, saved);
    }

    await agentRead(() => hydrateAgent(record), priority);
    this.remember(record, revision, true);
  }

  private async readPreview(record: AgentRecord, revision: string) {
    if (record.agent.harness === "claude" || !record.sessionId) {
      await this.full(record, false, 1);

      return;
    }

    try {
      const value = await agentRead(() => codexPreview(bridge.agentReader(), record.sessionId ?? ""), 1);

      record.agent.preview = value.preview;

      if (!record.pocket && !isActiveAgent(record.agent) && !record.observedStatus) {
        record.agent.status = nativeStatus(record.thread ?? { id: record.sessionId, turns: [] }, value.turns);
      }

      record.historyError = false;
    } catch {
      record.historyError = true;
    }

    this.remember(record, revision, false);
  }

  private async coalesce(key: string, read: () => Promise<void>) {
    const current = this.pending.get(key);

    if (current) {
      return current;
    }

    const done = read();

    this.pending.set(key, done);

    try {
      await done;
    } finally {
      if (this.pending.get(key) === done) {
        this.pending.delete(key);
      }
    }
  }

  async project(record: AgentRecord) {
    const saved = this.previews.get(record.agent.id);
    const revision = await agentRevision(record);

    if (saved?.revision === revision) {
      this.apply(record, saved);
    } else {
      record.agent.preview = saved?.agent.preview ?? "";
      record.agent.previewState = "loading";
    }

    return revision;
  }

  async warm(record: AgentRecord) {
    const revision = await this.project(record);

    if (this.fresh(record, this.previews.get(record.agent.id), revision)) {
      return;
    }

    await this.coalesce(`preview:${record.agent.id}`, () => this.readPreview(record, revision));
  }

  async full(record: AgentRecord, isImage = false, priority = 0) {
    if (priority === 0) {
      this.selected = record.agent.id;
    }

    const revision = await agentRevision(record);
    const saved = this.transcripts.get(record.agent.id);

    if (!this.fresh(record, saved, revision, isImage)) {
      await this.coalesce(`full:${record.agent.id}`, () => this.readFull(record, revision, priority));
    }

    const current = this.transcripts.get(record.agent.id);

    if (!current) {
      return;
    }

    this.apply(record, current);
    this.transcripts.delete(record.agent.id);
    this.transcripts.set(record.agent.id, current);
  }
}
