import { createHash } from "node:crypto";
import path from "node:path";
import { isTaskAuthoritative, type Ledger, type Task, type TaskEvent, type Membership } from "./model";
import type { TaskSource } from "./sources";
import { taskDelivery } from "./context";
import { indentedSourceLine, sourceLink, recordView } from "./render";

/** Generate a safe stable projection name without interpreting task IDs as paths.
@param taskId - Durable task identity.
@returns Host-owned Markdown basename.
*/
export function taskProjectionName(taskId: string) {
  return `task-${createHash("sha256").update(taskId).digest("hex")}.md`;
}

/** Match one task identity.
@param id - Durable task ID.
@param task - Candidate task.
@returns Identity equality.
*/
function hasTaskIdentity(id: string, task: Task) {
  return task.id === id;
}

/** Check whether a native input has an authoritative request-level association.
@param eventIds - Exact bound input identities.
@param member - Recorded membership.
@returns Whether the membership belongs to the original accepted input.
*/
function hasInputMembership(eventIds: ReadonlySet<string>, member: Membership) {
  return eventIds.has(member.eventId);
}

/** Resolve source-level task associations from authoritative ledger memberships.
@param state - Snapshot used to generate projections.
@param nativeEntryId - Exact original source identity.
@returns Task associations, including explicit content spans.
*/
export function sourceTaskAssociations(state: Ledger, nativeEntryId: string) {
  const associations = [];
  const inputOrigins = new Set<string>();

  for (const binding of state.bindings) {
    if (binding.nativeEntryId === nativeEntryId) {
      inputOrigins.add(`request:${binding.receiptId}`);
    }
  }

  const hasInputMembers = state.memberships.some(hasInputMembership.bind(undefined, inputOrigins));

  for (const member of state.memberships) {
    const task = state.tasks.find(hasTaskIdentity.bind(undefined, member.taskId));

    if (!task || !isTaskAuthoritative(state.mode, task)) {
      continue;
    }

    for (const event of state.events) {
      const isSource = hasInputMembers ? inputOrigins.has(event.id) : event.nativeEntryId === nativeEntryId;

      if (isSource && event.id === member.eventId) {
        associations.push({ taskId: member.taskId, eventId: member.eventId, span: member.span });
      }
    }
  }

  return associations;
}

/** Keep untrusted navigation titles on one line without interpreting their Markdown as task metadata.
@param text - User-derived title.
@returns Readable literal heading text.
*/
function navigationTitle(text: string) {
  return text.replaceAll(/\s+/gu, " ").replaceAll(/([\\`*_{}[\]()#+\-.!<>|])/gu, String.raw`\$1`);
}

/** Render one member with a bounded native preview and exact source references.
@param event - Original event metadata.
@param member - Authoritative association.
@param sources - Exact source records for preview generation.
@returns Readable member timeline entry.
*/
function memberMarkdown(event: TaskEvent, member: Membership, sources: TaskSource[]) {
  const PREVIEW_LENGTH = 1200;
  const lines = [
    `### ${JSON.stringify(event.id)} · ${event.origin}`,
    "",
    `Visibility: ${event.visibility} · Delivery: ${event.delivery} · Decision: ${JSON.stringify(member.decisionId)}`,
    `Content span: ${JSON.stringify(member.span ?? "whole event")}`,
    "",
    ...Array.from(event.text.split("\n"), indentedSourceLine),
  ];

  for (const source of sources) {
    if (source.entry.id !== event.nativeEntryId) {
      continue;
    }

    const view = recordView(source.entry);

    for (const part of view.parts) {
      const preview = part.text.slice(0, PREVIEW_LENGTH);

      lines.push(
        `${part.label}${part.callId ? ` · Call ID: ${part.callId}` : ""}`,
        ...Array.from(preview.split("\n"), indentedSourceLine)
      );

      if (preview.length < part.text.length) {
        lines.push("Preview truncated; read the exact original.");
      }
    }
  }

  for (const reference of event.contentRefs) {
    lines.push(
      path.isAbsolute(reference)
        ? `[Exact original](${sourceLink(reference)})`
        : `Recorded source identity: ${JSON.stringify(reference)}`
    );
  }

  return lines.join("\n");
}

/** Render the ledger's authoritative task view without duplicating exact native records.
@param state - Exact ledger snapshot.
@param task - Selected task.
@param directory - Explicit authorized parent path.
@param sources - Exact sources used for bounded member previews.
@returns Navigation Markdown with evidence and original source references.
*/
export function taskMarkdown(state: Ledger, task: Task, directory: string, sources: TaskSource[]) {
  const lines = [
    `# ${navigationTitle(task.title)}`,
    "",
    `Task ID: ${JSON.stringify(task.id)}`,
    `Ledger revision: ${String(state.revision)} · Task revision: ${String(task.revision)}`,
    `Authority: ${task.authority} · Work: ${task.work} · Retention: ${task.retention}`,
    `User delivery: ${taskDelivery(state, task).state}`,
    "",
    "## Original request",
    "",
    ...Array.from(task.originalIntent.split("\n"), indentedSourceLine),
    "",
    "## Current summary",
    "",
    ...Array.from(task.summary.split("\n"), indentedSourceLine),
    "",
    "## Pending questions",
    "",
  ];

  for (const question of task.pendingQuestions) {
    lines.push(...Array.from(question.split("\n"), indentedSourceLine));
  }

  lines.push("", "## Delegate assignments", "");

  for (const command of state.commands) {
    for (const member of state.memberships) {
      if (member.taskId === task.id && member.eventId === command.requestId) {
        lines.push(
          `Command ${JSON.stringify(command.id)} · Delegate ${JSON.stringify(command.childId)} · ` +
            `Request ${JSON.stringify(command.requestId)}`
        );
      }
    }
  }

  lines.push(
    "",
    "## Member timeline",
    "",
    "Membership follows recorded event order; it does not imply completion.",
    ""
  );

  for (const event of state.events) {
    for (const member of state.memberships) {
      if (member.taskId !== task.id || member.eventId !== event.id) {
        continue;
      }

      lines.push(memberMarkdown(event, member, sources));
    }
  }

  lines.push(
    "",
    `[Surrounding chronological context](${sourceLink(path.join(directory, "chronology.md"))})`,
    "Navigation text is a projection. Exact originals and the ledger retain the evidence.",
    ""
  );

  return lines.join("\n");
}
