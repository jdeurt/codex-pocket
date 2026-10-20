import { type AgentRecord } from "./agent-sources";
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
@returns The normalized cached read at its original completion time.
*/
export function completedRead(record: AgentRecord, revision: string, isFull: boolean): CachedRead {
  record.agent.previewState = previewState(record);

  return {
    identity: agentReadIdentity(record),
    revision,
    at: Date.now(),
    agent: { ...record.agent },
    historyError: record.historyError,
    ...(isFull && { turns: record.turns ?? [] }),
  };
}
