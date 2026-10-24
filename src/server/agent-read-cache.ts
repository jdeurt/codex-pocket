import { t as captureResult } from "try";
import { type AgentRecord, hydrateAgent, nativeStatus } from "./agent-sources";
import {
  type CachedRead,
  agentReadIdentity,
  completedRead,
  applyRead,
  isAttached,
  isFreshRead,
} from "../state/agent-read";
import { agentRead, promoteAgentRead } from "./agent-read-pool";
import { agentRevision } from "./agent-revision";
import { bridge } from "./bridge";
import { parentReaders } from "./pocket-readers";
import { codexPreview } from "./agent-history";
import { isActiveAgent } from "../lib/agents";
import { log } from "./logging";

const LIVE_REFRESH_MS = 2000;
const MAX_TRANSCRIPTS = 12;

/**
Read and project a lightweight native Codex preview without changing parent-owned status.
@param record - Scoped Codex record whose session has been checked by the caller.
@returns Updated native preview record.
*/
async function refreshPreview(record: AgentRecord) {
  const value = await agentRead(
    codexPreview.bind(
      undefined,
      (parentReaders.get(record.owner ?? "") ?? bridge).agentReader(),
      record.sessionId ?? ""
    ),
    isActiveAgent(record.agent) ? 1 : 2
  );

  const status =
    record.pocket || isActiveAgent(record.agent) || record.observedStatus
      ? record.agent.status
      : nativeStatus(record.thread ?? { id: record.sessionId ?? "", turns: [] }, value.turns);

  return { ...record, historyError: false, agent: { ...record.agent, preview: value.preview, status } };
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
    return isFreshRead(record, saved, revision, isImage, Date.now(), LIVE_REFRESH_MS);
  }

  /**
Save a preview and bound transcript retention while protecting the selected chat.
@param record - Agent after its native read completes.
@param revision - Revision associated with this read.
@param isFull - Whether this read included complete transcript turns.
*/
  private remember(record: AgentRecord, revision: string, isFull: boolean) {
    const value = completedRead(record, revision, isFull, Date.now());

    this.previews.set(record.agent.id, { ...value, turns: undefined });

    if (!isFull) {
      return;
    }

    this.transcripts.delete(record.agent.id);
    this.transcripts.set(record.agent.id, value);

    for (const id of this.transcripts.keys()) {
      if (this.transcripts.size <= MAX_TRANSCRIPTS) {
        return;
      }

      if (id !== this.selected) {
        this.transcripts.delete(id);
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

    const next = await agentRead(
      hydrateAgent.bind(undefined, applyRead(record, saved)),
      priority,
      agentReadIdentity(record)
    );

    this.remember(next, revision, true);
  }

  /**
Read a lightweight Codex preview or hydrate Claude's saved history.
@param record - Scoped agent whose preview needs refreshing.
@param revision - Revision to associate with the resulting preview.
*/
  private async readPreview(record: AgentRecord, revision: string) {
    if (record.agent.harness === "claude" || !record.sessionId || isAttached(record)) {
      await this.full(record, false, isActiveAgent(record.agent) ? 1 : 2);

      return;
    }

    const completed = await captureResult(refreshPreview, record);

    if (!completed.ok) {
      log().warn({ err: completed.error, agent: record.agent.id }, "agents.preview_failed");
    }

    this.remember(completed.ok ? completed.value : { ...record, historyError: true }, revision, false);
  }

  /** Retain usable cached history while recording a background refresh failure.
  @param pending - Read already owned by the cache's completion fence.
  @param agent - Scoped native identity for diagnostics.
  */
  private async refreshInBackground(pending: Promise<void>, agent: string) {
    const refreshed = await captureResult(pending);

    if (!refreshed.ok) {
      log().warn({ err: refreshed.error, agent }, "agents.refresh_failed");
    }
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

    const completed = await captureResult(done);

    if (this.pending.get(key) === done) {
      this.pending.delete(key);
    }

    if (!completed.ok) {
      throw completed.error;
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
@returns Current record with cached native history.
*/
  private touchTranscript(record: AgentRecord) {
    const current = this.transcripts.get(record.agent.id);

    if (current?.identity !== agentReadIdentity(record)) {
      return record;
    }

    this.transcripts.delete(record.agent.id);
    this.transcripts.set(record.agent.id, current);

    return applyRead(record, current);
  }

  /**
Apply an unchanged preview or mark its retained text loading after a revision change.
@param source - Discovered agent whose catalog row is being projected.
@returns New catalog record with the current preview.
*/
  async project(source: AgentRecord) {
    const { record, revision } = await agentRevision(source);
    const saved = this.previews.get(record.agent.id);

    return saved?.identity === agentReadIdentity(record) && saved.revision === revision
      ? applyRead(record, saved)
      : {
          ...record,
          agent: {
            ...record.agent,
            preview: saved?.identity === agentReadIdentity(record) ? saved.agent.preview : "",
            previewState: "loading" as const,
          },
        };
  }

  /**
Refresh a stale catalog preview while coalescing reads for the same agent.
@param source - Scoped agent whose preview is being warmed.
*/
  async warm(source: AgentRecord) {
    const { record, revision } = await agentRevision(source);

    if (this.fresh(record, this.previews.get(record.agent.id), revision)) {
      return;
    }

    await this.coalesce(`preview:${agentReadIdentity(record)}`, this.readPreview.bind(this, record, revision));
  }

  /**
Retain complete native history while protecting the selected chat from eviction.
@param source - Scoped agent whose full history is requested.
@param isImage - Whether the request only needs existing image metadata.
@param priority - Read-pool priority; zero also selects this transcript.
@returns Whether saved history was returned while its native refresh is still pending.
*/
  async full(source: AgentRecord, isImage = false, priority = 0) {
    const { record, revision } = await this.selectRevision(source, priority);
    const saved = this.transcripts.get(record.agent.id);
    const key = agentReadIdentity(record);
    const canReuse = priority === 0 && !isImage && saved?.identity === key && saved.turns !== undefined;

    if (!this.fresh(record, saved, revision, isImage)) {
      const pending = this.coalesce(`full:${key}`, this.readFull.bind(this, record, revision, priority));

      if (priority === 0) {
        promoteAgentRead(key);
      }

      if (canReuse) {
        void this.refreshInBackground(pending, record.agent.id);

        return { record: this.touchTranscript(record), isHistoryLoading: true };
      }

      await pending;
    }

    return { record: this.touchTranscript(record), isHistoryLoading: false };
  }
}
