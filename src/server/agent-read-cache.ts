import { type AgentRecord, hydrateAgent, nativeStatus, observedMetadata } from "./agent-sources";
import { type Turn } from "../lib/protocol";
import { agentRead } from "./agent-read-pool";
import { agentRevision } from "./agent-revision";
import { bridge } from "./bridge";
import { codexPreview } from "./agent-history";
import { isActiveAgent } from "../lib/agents";

const LIVE_REFRESH_MS = 2000;
const MAX_TRANSCRIPTS = 12;

interface CachedRead {
  revision: string;
  at: number;
  agent: AgentRecord["agent"];
  turns?: Turn[];
  historyError?: boolean;
}

/**
Project the preview availability from a completed native read.
@param record - Agent with its latest visible preview and read outcome.
@returns Existing unavailable, empty or visible-preview state.
*/
function previewState(record: AgentRecord) {
  if (record.historyError) {
    return "unavailable";
  }

  return record.agent.preview ? undefined : "empty";
}

/**
Capture native read metadata after updating its preview availability.
@param record - Agent whose read has completed.
@param revision - Discovery and file revision associated with the read.
@param isFull - Whether complete turns belong in the snapshot.
@returns The normalized cached read at its original completion time.
*/
function completedRead(record: AgentRecord, revision: string, isFull: boolean): CachedRead {
  record.agent.previewState = previewState(record);

  return {
    revision,
    at: Date.now(),
    agent: { ...record.agent },
    historyError: record.historyError,
    ...(isFull && { turns: record.turns ?? [] }),
  };
}

/**
Read and project a lightweight native Codex preview without changing parent-owned status.
@param record - Scoped Codex record whose session has been checked by the caller.
*/
async function refreshPreview(record: AgentRecord) {
  const value = await agentRead(() => codexPreview(bridge.agentReader(), record.sessionId ?? ""), 1);

  record.agent.preview = value.preview;

  if (!record.pocket && !isActiveAgent(record.agent) && !record.observedStatus) {
    record.agent.status = nativeStatus(record.thread ?? { id: record.sessionId ?? "", turns: [] }, value.turns);
  }

  record.historyError = false;
}

/**
Coalesce scoped native reads and retain bounded previews and selected transcripts.
*/
export class AgentReadCache {
  private selected = "";

  private previews = new Map<string, CachedRead>();

  private transcripts = new Map<string, CachedRead>();

  private pending = new Map<string, Promise<void>>();

  /**
Check whether a native revision and cached read remain reusable.
@param record - Discovered agent and current native file revision.
@param saved - Prior cached read, when available.
@param revision - Current serialized discovery and file revision.
@param isImage - Whether an existing image read may reuse the same revision.
@returns Whether revision, error age and activity permit cache reuse.
*/
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

  /**
Project validated cached metadata, preview and turns onto a discovery record.
@param record - Current discovery record authoritative for ownership.
@param saved - Cached read whose revision has been checked.
*/
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

  /**
Save a preview and bound transcript retention while protecting the selected chat.
@param record - Agent after its native read completes.
@param revision - Revision associated with this read.
@param isFull - Whether this read included complete transcript turns.
*/
  private remember(record: AgentRecord, revision: string, isFull: boolean) {
    const value = completedRead(record, revision, isFull);

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

  /**
Hydrate complete native history through the shared read pool and cache it.
@param record - Scoped agent record to hydrate.
@param revision - Revision associated with the request.
@param priority - Read-pool priority for selected or background work.
*/
  private async readFull(record: AgentRecord, revision: string, priority: number) {
    const saved = this.transcripts.get(record.agent.id);

    if (saved) {
      this.apply(record, saved);
    }

    await agentRead(() => hydrateAgent(record), priority);
    this.remember(record, revision, true);
  }

  /**
Read a lightweight Codex preview or hydrate Claude's saved history.
@param record - Scoped agent whose preview needs refreshing.
@param revision - Revision to associate with the resulting preview.
*/
  private async readPreview(record: AgentRecord, revision: string) {
    if (record.agent.harness === "claude" || !record.sessionId) {
      await this.full(record, false, 1);

      return;
    }

    try {
      await refreshPreview(record);
    } catch {
      record.historyError = true;
    }

    this.remember(record, revision, false);
  }

  /**
Share one pending native read per cache key and release only its own completion.
@param key - Preview or transcript cache key.
@param read - Concrete native read creating the pending operation.
@returns Completion of the shared read.
*/
  private async coalesce(key: string, read: () => Promise<void>) {
    const current = this.pending.get(key);

    return current ?? this.readOnce(key, read);
  }

  /**
Own a newly started cache read until its exact pending entry settles.
@param key - Cache key already checked for a pending read.
@param read - Native read to start once.
@returns Completion of this owned read.
*/
  private async readOnce(key: string, read: () => Promise<void>) {
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

  /**
Mark a selected chat before obtaining its native revision.
@param record - Scoped agent being read.
@param priority - Zero identifies the selected transcript.
@returns Revision read after selection ownership is established.
*/
  private selectRevision(record: AgentRecord, priority: number) {
    if (priority === 0) {
      this.selected = record.agent.id;
    }

    return agentRevision(record);
  }

  /**
Apply and mark the completed transcript as most recently used.
@param record - Scoped agent whose cache refresh has settled.
*/
  private touchTranscript(record: AgentRecord) {
    const current = this.transcripts.get(record.agent.id);

    if (!current) {
      return;
    }

    this.apply(record, current);
    this.transcripts.delete(record.agent.id);
    this.transcripts.set(record.agent.id, current);
  }

  /**
Apply an unchanged preview or mark its retained text loading after a revision change.
@param record - Discovered agent whose catalog row is being projected.
@returns Current discovery and native file revision.
*/
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

  /**
Refresh a stale catalog preview while coalescing reads for the same agent.
@param record - Scoped agent whose preview is being warmed.
*/
  async warm(record: AgentRecord) {
    const revision = await this.project(record);

    if (this.fresh(record, this.previews.get(record.agent.id), revision)) {
      return;
    }

    await this.coalesce(`preview:${record.agent.id}`, () => this.readPreview(record, revision));
  }

  /**
Retain complete native history while protecting the selected chat from eviction.
@param record - Scoped agent whose full history is requested.
@param isImage - Whether the request only needs existing image metadata.
@param priority - Read-pool priority; zero also selects this transcript.
*/
  async full(record: AgentRecord, isImage = false, priority = 0) {
    const revision = await this.selectRevision(record, priority);
    const saved = this.transcripts.get(record.agent.id);

    if (!this.fresh(record, saved, revision, isImage)) {
      await this.coalesce(`full:${record.agent.id}`, () => this.readFull(record, revision, priority));
    }

    this.touchTranscript(record);
  }
}
