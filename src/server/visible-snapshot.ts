import { type DelegateReport } from "../lib/delegate-reports";
import { type Item, type Snapshot, object, string } from "../lib/protocol";
import { itemImageSources, itemImageUrl } from "../lib/images";
import { currentActivity } from "./activity";
import { delegationMessagePrefix } from "./delegation-mail";
import { isRecoveryMessageId } from "./recovery";
import { projectRestarts } from "./restart-events";
import { toolTrace } from "./tool-trace";

/**
Recognize reserved recovery and delegation identities without inspecting message text.
@param id - Untrusted native or receipt message identity.
@returns Whether this message belongs to internal Pocket work.
*/
const isInternal = (id: unknown) => isRecoveryMessageId(id) || string(id).startsWith(delegationMessagePrefix);

/**
Keep uploaded original-file display text while removing private transport content from the phone snapshot.
@param item - Native user message carrying normalized attachment receipts.
@returns Existing static attachment message without image-preview transport fields.
*/
function attachmentMessage(item: Item): Item {
  const { pocketAttachmentText, ...message } = item;

  return {
    ...message,
    images: undefined,
    content: pocketAttachmentText ? [{ type: "text", text: pocketAttachmentText }] : [],
  };
}

/**
Project visible tool text and images after ordinary messages have been selected.
@param item - Native output item already checked for internal-message exclusions.
@param images - Shared normalized image sources routed through guarded endpoints.
@param hasTools - Whether this read-only snapshot includes native tool traces.
@returns Existing tool or image row, or no row when the item has no visible output.
*/
function visibleTool(item: Item, images: NonNullable<Item["images"]>, hasTools: boolean): Item | Item[] {
  const tool = hasTools ? toolTrace(item) : undefined;

  if (tool) {
    return { ...tool, ...(images.length > 0 && { images }) };
  }

  return images.length > 0 ? { id: item.id, type: "imageOutput", images } : [];
}

/**
Route native image sources once and retain message text or explicit tool output.
@param item - Native visible message or output item.
@param hasTools - Whether this read-only snapshot exposes native tool traces.
@returns Normalized phone display item, or no row for output without visible content.
*/
function visibleOutput(item: Item, hasTools: boolean): Item | Item[] {
  const images = itemImageSources(item).map((source, index) => ({
    source: /^https?:\/\//i.test(source) ? source : itemImageUrl(item.id, index),
    alt: "Image from Pocket",
  }));

  if (["userMessage", "agentMessage"].includes(item.type)) {
    return {
      ...item,
      ...(images.length > 0 && {
        images,
        content: Array.isArray(item.content)
          ? item.content.filter((part) => object(part).type === "text")
          : item.content,
      }),
    };
  }

  return visibleTool(item, images, hasTools);
}

/**
Exclude internal work and preserve explicit restart and original-file rows before projecting output.
@param item - Canonical native or restart item.
@param scheduled - Hidden scheduled message identities for this snapshot.
@param hasTools - Whether native tool traces belong in this read-only view.
@returns The existing phone display projection, including deliberate empty output.
*/
function displayItem(
  item: Item,
  scheduled: Set<string>,
  hasTools: boolean,
  reports: Map<string, DelegateReport>
): Item | Item[] {
  const report = reports.get(string(item.clientId));

  if (item.type === "userMessage" && report) {
    reports.delete(report.id);

    return { id: report.id, type: "delegateReport", delegateReport: report };
  }

  if (item.type === "pocketRestart") {
    return { id: item.id, type: item.type };
  }

  if (item.type === "userMessage" && (scheduled.has(string(item.clientId)) || isInternal(item.clientId))) {
    return [];
  }

  return item.type === "userMessage" && Array.isArray(item.attachments)
    ? attachmentMessage(item)
    : visibleOutput(item, hasTools);
}

/**
Expose only canonical messages and explicit display projections to the phone.
@param state - Internal parent or agent snapshot whose ownership has already been checked.
@param options - Existing opt-in for read-only native tool traces.
@returns Snapshot with internal work hidden and guarded visible outputs normalized.
*/
// Only messages and explicitly projected display items leave the computer.
export function visibleSnapshot(
  state: Snapshot,
  options: { tools?: boolean; reports?: DelegateReport[] } = {}
): Snapshot {
  const scheduled = new Set(Object.keys(state.scheduled));
  const reports = new Map((options.reports ?? []).map((report) => [report.id, report]));
  const turns = projectRestarts(state).map((turn) => ({
    ...turn,
    items: turn.items.flatMap<Item>((item) => displayItem(item, scheduled, options.tools === true, reports)),
  }));

  for (const report of reports.values()) {
    turns.push({
      id: report.id,
      status: "completed",
      items: [{ id: report.id, type: "delegateReport", delegateReport: report }],
    });
  }

  return {
    ...state,
    activity: currentActivity(state),
    notices: [],
    scheduled: {},
    restartEvents: undefined,
    queue: state.queue.filter((message) => !scheduled.has(message.id) && !isInternal(message.id)),
    turns,
  };
}
