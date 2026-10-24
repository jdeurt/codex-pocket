import { type AgentTranscript, isActiveAgent } from "../lib/agents";
import {
  type Snapshot,
  type Turn,
  type Item,
  initialSnapshot,
  object,
  string,
  isTextContent,
  findItem,
  hasHistory,
  isTurnInProgress,
} from "../lib/protocol";
import { type AgentRecord } from "./agent-sources";
import { itemImageSources } from "../lib/images";
import { markdownImageSource } from "./agent-images";
import { visibleSnapshot } from "../state/visible-snapshot";

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

  return hasHistory(state.turns) ? "available" : "empty";
}

/** Select only native text content for read-only output.
@param part - Native text part.
@returns Detached text representation.
*/
function textPart(part: unknown) {
  return { type: "text", text: string(object(part).text) };
}

/** Route one image through its owned agent and native item.
@param base - Authorized item route.
@param _image - Source metadata, never exposed directly.
@param index - Native image index.
@returns Guarded image metadata.
*/
function agentImage(base: string, _image: unknown, index: number) {
  return { alt: "Image from Pocket", source: `${base}&index=${String(index)}` };
}

/** Project only public fields from one owned native item.
@param id - Agent identity.
@param item - Owned native item.
@returns Read-only display item.
*/
function agentItem(id: string, item: Item): Item {
  const base = `/api/agents?agent=${encodeURIComponent(id)}&item=${encodeURIComponent(item.id)}`;

  return {
    id: item.id,
    type: item.type,
    ...(typeof item.text === "string" && { text: item.text }),
    ...(item.type === "agentMessage" && { imageBase: base }),
    ...(typeof item.phase === "string" && { phase: item.phase }),
    ...(Array.isArray(item.content) && { content: Array.from(item.content.filter(isTextContent), textPart) }),
    ...(item.type === "toolTrace" && { tool: item.tool, toolLabels: item.toolLabels, status: item.status }),
    ...(Array.isArray(item.images) && { images: Array.from(item.images, agentImage.bind(undefined, base)) }),
  };
}

/** Project one owned native turn with explicit agent identity.
@param id - Agent identity.
@param turn - Owned native turn.
@returns Detached read-only turn.
*/
function agentTurn(id: string, turn: Turn): Turn {
  return { id: turn.id, status: turn.status, items: Array.from(turn.items, agentItem.bind(undefined, id)) };
}

/**
Project a scoped native transcript with guarded image routes and no writable parent APIs.
@param record - Owned fully hydrated native agent record.
@param id - Scoped catalog identity encoded into guarded image routes.
@param now - Explicit projection timestamp.
@returns Read-only transcript using canonical turn and tool projections.
*/
export function projectAgentTranscript(record: AgentRecord, id: string, now: number): AgentTranscript {
  const raw: Snapshot = {
    ...structuredClone(initialSnapshot),
    connection: "connected",
    title: record.agent.name,
    model: record.agent.model,
    reasoningEffort: record.agent.reasoningEffort,
    turns: record.turns ?? [],
    requests: record.requests ?? [],
    activeTurnId:
      !record.historyError && isActiveAgent(record.agent) ? record.turns?.findLast(isTurnInProgress)?.id : undefined,
  };
  const visible = visibleSnapshot(raw, { tools: true });
  const state = { ...visible, turns: Array.from(visible.turns, agentTurn.bind(undefined, id)) };

  return {
    agent: record.agent,
    state,
    history: historyAvailability(record, state),
    ...(record.historyError && {
      warning: "Saved history is unavailable. Check harness access on your computer. Reconnecting automatically.",
    }),
    updatedAt: now,
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
  const item = findItem(record.turns ?? [], itemId);
  const source = item && (markdownSource ? markdownImageSource(item, markdownSource) : itemImageSources(item)[index]);

  if (!source || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("Image is unavailable in this agent chat.");
  }

  return { source, cwd: record.cwd };
}
