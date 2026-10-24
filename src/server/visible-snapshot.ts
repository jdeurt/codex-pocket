import { type Item, type Snapshot, type Turn, string, isTextContent } from "../lib/protocol";
import { itemImageSources, itemImageUrl } from "../lib/images";
import { type DelegateReport } from "../lib/delegate-reports";
import { currentActivity } from "./activity";
import { delegationMessagePrefix } from "./delegation-mail";
import { isRecoveryMessageId } from "../state/recovery";
import { projectRestarts } from "../state/restarts";
import { REALTIME_TOOL_PREFIX } from "./realtime-tools";
import { toolTrace } from "./tool-trace";

/**
Recognize reserved recovery and delegation identities without inspecting message text.
@param id - Untrusted native or receipt message identity.
@returns Whether this message belongs to internal Pocket work.
*/
const isInternal = (id: unknown) =>
  isRecoveryMessageId(id) ||
  string(id).startsWith(delegationMessagePrefix) ||
  string(id).startsWith(REALTIME_TOOL_PREFIX);

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

/** Route one image without exposing local paths.
@param itemId - Owning native item.
@param source - Normalized image source.
@param index - Image index within the item.
@returns Guarded image metadata.
*/
function visibleImage(itemId: string, source: string, index: number) {
  return { source: /^https?:\/\//i.test(source) ? source : itemImageUrl(itemId, index), alt: "Image from Pocket" };
}

/** Exclude scheduled and internal work from the visible delivery queue.
@param scheduled - Hidden scheduled identities.
@param message - Canonical queued delivery.
@returns Whether this delivery belongs in the public transcript.
*/
function isVisibleQueuedMessage(scheduled: ReadonlySet<string>, message: Snapshot["queue"][number]) {
  return !scheduled.has(message.id) && !isInternal(message.id);
}

/**
Route native image sources once and retain message text or explicit tool output.
@param item - Native visible message or output item.
@param hasTools - Whether this read-only snapshot exposes native tool traces.
@returns Normalized phone display item, or no row for output without visible content.
*/
function visibleOutput(item: Item, hasTools: boolean): Item | Item[] {
  const images = Array.from(itemImageSources(item), visibleImage.bind(undefined, item.id));

  if (["userMessage", "agentMessage"].includes(item.type)) {
    return {
      ...item,
      ...(images.length > 0 && {
        images,
        content: Array.isArray(item.content) ? item.content.filter(isTextContent) : item.content,
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
function displayItem(item: Item, scheduled: ReadonlySet<string>, hasTools: boolean): Item | Item[] {
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

/** Project a turn and report consumed delivery IDs without mutating caller-owned maps.
@param turn - Native turn.
@param scheduled - Hidden scheduled identities.
@param hasTools - Whether tool details are visible.
@param reports - Available report projections.
@returns Turn and explicit consumed-report identities.
*/
function projectedTurn(
  turn: Turn,
  scheduled: ReadonlySet<string>,
  hasTools: boolean,
  reports: ReadonlyMap<string, DelegateReport>
) {
  const items: Item[] = [];
  const consumed = new Set<string>();

  let isWorker = false;

  for (const item of turn.items) {
    if (item.type === "userMessage") {
      isWorker = item.id.startsWith(REALTIME_TOOL_PREFIX) || string(item.clientId).startsWith(REALTIME_TOOL_PREFIX);
    }

    if (isWorker && ["userMessage", "agentMessage"].includes(item.type)) {
      continue;
    }

    const report = reports.get(string(item.clientId));

    if (report && item.type === "userMessage" && !consumed.has(report.id)) {
      consumed.add(report.id);
      items.push({ id: report.id, type: "delegateReport", delegateReport: report });
    } else {
      const projected = displayItem(item, scheduled, hasTools);

      items.push(...(Array.isArray(projected) ? projected : [projected]));
    }
  }

  return { turn: { ...turn, items }, consumed };
}

/**
Project one native turn through the shared visible-message and image boundary.
@param turn - Canonical native or restart-projected turn.
@param options - Hidden scheduled identities and the existing opt-in for native tool traces.
@returns Turn containing only the phone's normalized display items.
*/
export function visibleTurn(
  turn: Turn,
  options: { scheduled?: Set<string>; tools?: boolean; reports?: Map<string, DelegateReport> } = {}
): Turn {
  return projectedTurn(turn, options.scheduled ?? new Set(), options.tools === true, options.reports ?? new Map()).turn;
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
  const { activityState: _hostActivity, ...publicState } = state;
  const scheduled = new Set(Object.keys(state.scheduled));
  const reports = new Map<string, DelegateReport>();

  const reportEntries = options.reports ?? [];

  for (const report of reportEntries) {
    reports.set(report.id, report);
  }

  const turns: Turn[] = [];

  for (const turn of projectRestarts(state)) {
    const projected = projectedTurn(turn, scheduled, options.tools === true, reports);

    turns.push(projected.turn);

    for (const id of projected.consumed) {
      reports.delete(id);
    }
  }

  for (const report of reports.values()) {
    turns.push({
      id: report.id,
      status: "completed",
      items: [{ id: report.id, type: "delegateReport", delegateReport: report }],
    });
  }

  return {
    ...publicState,
    activity: currentActivity(state),
    notices: [],
    scheduled: {},
    restartEvents: undefined,
    queue: state.queue.filter(isVisibleQueuedMessage.bind(undefined, scheduled)),
    turns,
  };
}
