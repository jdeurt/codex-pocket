import { type AgentRecord, observedMetadata } from "./agent-metadata";
import { type Turn } from "../lib/protocol";
import { sessionAttachment } from "./session-adoption";

/**
Identify the exact native source behind a scoped agent cache entry and queued read.
@param record - Verified parent-owned native source.
@returns Identity that changes when the parent, native session or owning socket changes.
*/
export function agentReadIdentity(record: AgentRecord) {
  return JSON.stringify([
    record.owner,
    record.agent.id,
    record.agent.harness,
    record.sessionId,
    record.cwd,
    record.claudeRoot,
    record.claudeAgent,
    record.pocket && sessionAttachment(record.pocket.metadata)?.socketPath,
  ]);
}

export interface CachedRead {
  identity: string;
  revision: string;
  at: number;
  agent: AgentRecord["agent"];
  turns?: Turn[];
  historyError?: boolean;
}

/**
Identify live attachments whose owner can change independently of Pocket's persisted status.
@param record - Scoped agent record.
@returns Whether live socket reads must expire even while the stored child is idle.
*/
export function isAttached(record: AgentRecord) {
  return !!record.pocket && !!sessionAttachment(record.pocket.metadata);
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
@param completedAt - Explicit completion timestamp supplied by the runtime.
@returns The normalized cached read without changing the discovery record.
*/
export function completedRead(record: AgentRecord, revision: string, isFull: boolean, completedAt: number): CachedRead {
  return {
    identity: agentReadIdentity(record),
    revision,
    at: completedAt,
    agent: { ...record.agent, previewState: previewState(record) },
    historyError: record.historyError,
    ...(isFull && { turns: record.turns ?? [] }),
  };
}

/** Decide whether a completed read can be reused from explicit age and revision inputs.
@param record - Current scoped discovery record.
@param saved - Previous completed read, if present.
@param revision - Current discovery and file revision.
@param isImage - Whether this lookup only needs existing image metadata.
@param now - Runtime-supplied clock value.
@param maximumAge - Maximum age for live or failed reads.
@returns Whether the saved read remains valid.
*/
export function isFreshRead(
  record: AgentRecord,
  saved: CachedRead | undefined,
  revision: string,
  isImage: boolean,
  now: number,
  maximumAge: number
) {
  if (saved?.identity !== agentReadIdentity(record) || saved.revision !== revision) {
    return false;
  }

  const isRecent = now - saved.at < maximumAge;

  return (
    (!saved.historyError || isRecent) &&
    (isImage ||
      (record.agent.harness === "claude" && Boolean(record.fileRevision)) ||
      (!isAttached(record) && ["idle", "completed", "failed", "closed"].includes(record.agent.status)) ||
      isRecent)
  );
}

/** Merge a verified cached read without changing either source.
@param record - Current authoritative ownership record.
@param saved - Optional completed native read.
@returns Record with reusable history and metadata.
*/
export function applyRead(record: AgentRecord, saved?: CachedRead): AgentRecord {
  if (saved?.identity !== agentReadIdentity(record)) {
    return record;
  }

  const canSettle =
    !record.pocket &&
    ["idle", "unknown"].includes(record.agent.status) &&
    ["completed", "failed", "closed"].includes(saved.agent.status);
  const isLive = isAttached(record) && !["closing", "closed"].includes(record.pocket?.status ?? "");

  return {
    ...record,
    agent: {
      ...record.agent,
      ...observedMetadata({ model: saved.agent.model, effort: saved.agent.reasoningEffort }),
      preview: saved.agent.preview,
      previewState: saved.agent.previewState,
      status: canSettle || isLive ? saved.agent.status : record.agent.status,
    },
    turns: saved.turns ?? record.turns,
    historyError: record.discoveryError === true || saved.historyError,
  };
}
