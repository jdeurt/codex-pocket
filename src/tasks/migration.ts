import path from "node:path";
import { taskDirectory } from "./archive";
import { readTaskState } from "./adapters/legacy-state";
import { legacyMemberships, type LegacyMembership } from "./shadow";
import { readTaskSources, type TaskSource } from "./sources";
import { readTaskLedger } from "./management";
import { updateTasks } from "./repository";
import { recordEvent, assignEvent, hasEventId, hasTaskId } from "./transitions";
import { assignmentDecision, latestDecision, reconcileRoutes } from "./reconciliation";
import type { Ledger } from "./model";

const MIGRATION_VERSION = 1;
const TITLE_LENGTH = 160;
const LAST = -1;

/** Match the exact original native identity.
@param id - Original source identity.
@param source - Validated source.
@returns Identity equality.
*/
function hasSourceId(id: string, source: TaskSource) {
  return source.entry.id === id;
}

/** Preserve original legacy task state and expose retention without implying completion.
@param member - Recorded archive status.
@param task - Existing task value.
@returns Legacy metadata for the referenced task.
*/
function legacyTaskMetadata(member: LegacyMembership, task: Ledger["tasks"][number]): Ledger["tasks"][number] {
  return task.id === member.taskId
    ? { ...task, authority: "legacy", retention: member.status === "closed" ? "archived" : "active" }
    : task;
}

/** Adopt one explicit legacy membership with durable bindings where available.
@param member - Recorded membership.
@param sources - Exact retained originals.
@param state - Input checkpoint.
@returns Legacy association with no inferred completion.
*/
function adoptLegacyMember(member: LegacyMembership, sources: TaskSource[], state: Ledger): Ledger {
  let next = state;

  const eventId = `native:${member.nativeEntryId}`;

  let event = next.events.find(hasEventId.bind(undefined, eventId));

  if (!event) {
    const source = sources.find(hasSourceId.bind(undefined, member.nativeEntryId));

    next = recordEvent(next, {
      id: eventId,
      nativeEntryId: member.nativeEntryId,
      parentId: state.parentId,
      origin: "legacy",
      text: source?.entry.text ?? "",
      contentRefs: [source?.file ?? member.file],
      visibility: "unknown",
      delivery: "not_delivered",
    });
    event = next.events.find(hasEventId.bind(undefined, eventId));
  }

  const originalIntent =
    sources.find(hasSourceId.bind(undefined, member.nativeEntryId))?.entry.text ?? event?.text ?? "";
  const isExists = next.tasks.some(hasTaskId.bind(undefined, member.taskId));
  const assignment = isExists
    ? { kind: "attach" as const, taskIds: [member.taskId] }
    : {
        kind: "create" as const,
        taskId: member.taskId,
        title: originalIntent.trim() ? originalIntent.slice(0, TITLE_LENGTH) : `Legacy task ${member.taskId}`,
        originalIntent,
      };
  const decision = assignmentDecision(
    next,
    eventId,
    assignment,
    "legacy",
    "legacy-archive-v1",
    "Preserved explicit historical membership. Missing provenance and completion evidence remain unknown."
  );

  const prior = latestDecision(next, eventId);

  next = assignEvent(next, { ...decision, supersedes: prior?.source === "legacy" ? [] : decision.supersedes });
  const receipt = event?.receiptId ? `request:${event.receiptId}` : undefined;

  if (receipt && next.events.some(hasEventId.bind(undefined, receipt))) {
    const receiptDecision = assignmentDecision(
      next,
      receipt,
      { kind: "attach", taskIds: [member.taskId] },
      "legacy",
      "legacy-binding-v1",
      "Follow the durable receipt-to-native binding for preserved legacy membership."
    );

    next = assignEvent(next, receiptDecision);
  }

  const tasks = Array.from(next.tasks, legacyTaskMetadata.bind(undefined, member));

  next = { ...next, tasks };

  return next;
}

/** Preserve historical membership as a legacy decision without inventing provenance or completion.
@param records - Explicit archived memberships.
@param sources - Exact originals, when available.
@param cursor - Last already-ingested native entry.
@param nextSequence - First unused exact source sequence.
@param state - Shadow checkpoint to adopt conservatively.
@returns Live checkpoint retaining original archive memberships and unknowns.
*/
function adoptLegacy(
  records: LegacyMembership[],
  sources: TaskSource[],
  cursor: string | null,
  nextSequence: number,
  state: Ledger
): Ledger {
  if (state.migrationVersion >= MIGRATION_VERSION) {
    return state;
  }

  let next: Ledger = { ...state, mode: "live" };

  for (const source of sources) {
    const id = `native:${source.entry.id}`;

    if (!next.events.some(hasEventId.bind(undefined, id))) {
      next = recordEvent(next, {
        id,
        nativeEntryId: source.entry.id,
        parentId: state.parentId,
        origin: "legacy",
        text: "",
        contentRefs: [source.file],
        visibility: "unknown",
        delivery: "not_delivered",
      });
    }
  }

  for (const member of records) {
    next = adoptLegacyMember(member, sources, next);
  }

  // Shadow classifications remain proposals. Historical unassigned requests are never silently reclassified live.
  for (const event of next.events) {
    const decision = latestDecision(next, event.id);

    if (decision?.source === "legacy" || decision?.source === "correction") {
      continue;
    }

    const source = ["typed", "voice_request", "scheduled", "legacy"].includes(event.origin) ? "legacy" : "policy";
    const legacy = assignmentDecision(
      next,
      event.id,
      { kind: "unresolved", diagnostic: "Historical provenance retained for review; no automatic reclassification." },
      source,
      "legacy-cutover-v1",
      "Conservative migration: historical requests and commands are not replayed."
    );

    next = assignEvent(next, legacy);
  }

  return reconcileRoutes({
    ...next,
    migrationVersion: MIGRATION_VERSION,
    cursor: next.cursor ?? cursor,
    nextSequence: Math.max(next.nextSequence, nextSequence),
  });
}

/** Match explicit archive and checkpoint membership without semantic guessing.
@param expected - Active checkpoint membership.
@param member - Retained archive membership.
@returns Whether the recorded relationship is already present.
*/
function isLegacyMember(expected: LegacyMembership, member: LegacyMembership) {
  return member.taskId === expected.taskId && member.nativeEntryId === expected.nativeEntryId;
}

/** Adopt old checkpoints and archives once, without sending native input or invoking a classifier.
@param parentId - Owning parent.
@returns Authoritative live ledger; old files remain unchanged.
*/
export async function migrateTaskLedger(parentId: string) {
  const existing = readTaskLedger(parentId);

  if (existing.migrationVersion >= MIGRATION_VERSION) {
    return existing;
  }

  const legacy = await readTaskState(parentId);
  const records = await legacyMemberships(parentId);

  const activeMembers = legacy.open?.matched ?? [];

  for (const nativeEntryId of activeMembers) {
    const member = {
      taskId: legacy.open?.id ?? "",
      nativeEntryId,
      status: "open",
      file: path.join(taskDirectory(parentId), "active.json"),
    };

    if (!records.some(isLegacyMember.bind(undefined, member))) {
      records.push(member);
    }
  }

  const sources = await readTaskSources(parentId);
  const lastSequence = sources.at(LAST)?.entry.sequence;
  const nextSequence = lastSequence === undefined ? 0 : lastSequence + 1;

  return updateTasks(
    parentId,
    "Conservatively adopt legacy archive memberships without replay",
    adoptLegacy.bind(undefined, records, sources, legacy.sourceCursor, nextSequence)
  );
}
