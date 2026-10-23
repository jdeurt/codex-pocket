import { type AgentTranscript, isActiveAgent } from "../lib/agents";
import { type Snapshot, initialSnapshot, object, string } from "../lib/protocol";
import { type AgentRecord } from "./agent-sources";
import { itemImageSources } from "../lib/images";
import { markdownImageSource } from "./agent-images";
import { visibleSnapshot } from "./visible-snapshot";

/**
Distinguish failed reads from available or empty canonical visible history.
@param record - Scoped record carrying the latest native read outcome.
@param state - Normalized phone snapshot after internal outputs have been removed.
@returns Existing unavailable, available or empty history state.
*/
function historyAvailability(record: AgentRecord, state: Snapshot): AgentTranscript["history"] {
  if (record.historyError) {
    return "unavailable";
  }

  return state.turns.some((turn) => turn.items.length > 0) ? "available" : "empty";
}

/**
Project a scoped native transcript with guarded image routes and no writable parent APIs.
@param record - Owned fully hydrated native agent record.
@param id - Scoped catalog identity encoded into guarded image routes.
@returns Read-only transcript using canonical turn and tool projections.
*/
export function projectAgentTranscript(record: AgentRecord, id: string): AgentTranscript {
  const raw: Snapshot = {
    ...structuredClone(initialSnapshot),
    connection: "connected",
    title: record.agent.name,
    model: record.agent.model,
    reasoningEffort: record.agent.reasoningEffort,
    turns: record.turns ?? [],
    requests: record.requests ?? [],
    activeTurnId:
      !record.historyError && isActiveAgent(record.agent)
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
      ...(item.type === "toolTrace" && { tool: item.tool, toolLabels: item.toolLabels, status: item.status }),
      ...(Array.isArray(item.images) && {
        images: item.images.map((_, index) => ({
          alt: "Image from Pocket",
          source: `/api/agents?agent=${encodeURIComponent(id)}&item=${encodeURIComponent(item.id)}&index=${String(index)}`,
        })),
      }),
    })),
  }));

  return {
    agent: record.agent,
    state,
    history: historyAvailability(record, state),
    ...(record.historyError && {
      warning: "Saved history is unavailable. Check harness access on your computer. Reconnecting automatically.",
    }),
    updatedAt: Date.now(),
  };
}

/**
Authorize an image source against an owned hydrated native item.
@param record - Owned agent record after its native history read completes.
@param itemId - Native item identity within this agent.
@param index - Requested nonnegative image index.
@param markdownSource - Optional exact source checked against the owned assistant Markdown AST.
@returns Native source and working directory, or an unavailable-image error.
*/
export function agentImageSource(
  record: AgentRecord,
  itemId: string,
  index: number,
  markdownSource: string | undefined
) {
  const item = record.turns?.flatMap((turn) => turn.items).find((entry) => entry.id === itemId);
  const source = item && (markdownSource ? markdownImageSource(item, markdownSource) : itemImageSources(item)[index]);

  if (!source || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("Image is unavailable in this agent chat.");
  }

  return { source, cwd: record.cwd };
}
