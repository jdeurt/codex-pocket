import { createHash } from "node:crypto";
import { object, string } from "../lib/protocol";
import { TASK_CLASSIFIERS } from "./classifier-definitions";
import { latestDecision } from "./reconciliation";
import { recordView } from "./render";
import type { Ledger, Task, TaskEvent } from "./model";
import type { TaskSource } from "./sources";
import { taskRequestUpdates, type TaskRequestUpdate } from "./intent-context";

export interface CommandEvidence {
  id: string;
  childId: string;
  status: string;
  body: string;
  isSettled: boolean;
}

export interface LifecycleInput {
  task: {
    id: string;
    originalIntent: string;
    work: Task["work"];
    intentTruncated: boolean;
    pendingQuestions: string[];
  };
  latestRequestId: string;
  isMainTurnActive: boolean;
  requests: { eventId: string; text: string; references: string[]; truncated: boolean }[];
  omittedRequests: number;
  events: {
    eventId: string;
    origin: TaskEvent["origin"];
    text: string;
    truncated: boolean;
    toolName?: string;
    isError?: boolean;
    delivery: TaskEvent["delivery"];
  }[];
  pendingQuestions: { eventId: string; question: string }[];
  answeredQuestions: { eventId: string; questionEventId: string; question: string }[];
  omittedQuestions: number;
  commands: CommandEvidence[];
  omittedEvents: number;
}

/** Select a task's exact source identities without reading transport text for provenance.
@param state - Parent checkpoint.
@param taskId - Task under review.
@returns Task-member event identities.
*/
function memberIds(state: Ledger, taskId: string) {
  const ids = new Set<string>();

  for (const member of state.memberships) {
    if (member.taskId === taskId) {
      ids.add(member.eventId);
    }
  }

  return ids;
}

/** Locate the immutable original behind an event or its durable receipt binding.
@param state - Parent checkpoint.
@param sources - Validated exact sources.
@param event - Task-member event.
@returns Original source where the application recorded one.
*/
function eventSource(state: Ledger, sources: TaskSource[], event: TaskEvent) {
  let nativeId = event.nativeEntryId;

  for (const binding of state.bindings) {
    if (event.receiptId && binding.receiptId === event.receiptId) {
      nativeId = binding.nativeEntryId;
    }
  }

  for (const source of sources) {
    if (source.entry.id === nativeId) {
      return source;
    }
  }
}

/** Preserve source labels while bounding classifier evidence explicitly.
@param state - Parent checkpoint.
@param sources - Validated originals.
@param event - Task member.
@returns Exact preview and an explicit truncation flag.
*/
function eventEvidence(state: Ledger, sources: TaskSource[], event: TaskEvent) {
  const source = eventSource(state, sources, event);

  let isDelegateReport = event.origin === "delegate_report";

  for (const original of state.events) {
    if (event.receiptId && original.receiptId === event.receiptId && original.origin === "delegate_report") {
      isDelegateReport = true;
    }
  }

  const parts = source && (isDelegateReport || source.entry.role !== "user") ? recordView(source.entry).parts : [];
  const text = [event.text];

  for (const part of parts) {
    text.push(`${part.label}: ${part.text}`);
  }

  const original = text.join("\n");
  const isMissingOriginal =
    !source && (event.nativeEntryId !== undefined || (event.origin === "delegate_report" && !event.text.trim()));

  return {
    eventId: event.id,
    origin: event.origin,
    toolName: event.toolName,
    isError: event.isError,
    delivery: event.delivery,
    callId: event.callId,
    callIds: event.callIds,
    inReplyTo: event.inReplyTo,
    requestId: event.requestId,
    text: original.slice(0, TASK_CLASSIFIERS.lifecycle.maxEvidenceLength),
    truncated: isMissingOriginal || original.length > TASK_CLASSIFIERS.lifecycle.maxEvidenceLength,
  };
}

/** Recover unanswered native phone questions from recorded calls and exact tool-result identities.
@param state - Parent checkpoint.
@param sources - Validated originals.
@param events - Current task-member events.
@returns Actual outstanding questions, never model-invented text.
*/
function unansweredQuestions(state: Ledger, sources: TaskSource[], events: TaskEvent[]) {
  const answered = new Map<string, TaskEvent>();
  const questions: LifecycleInput["pendingQuestions"] = [];
  const completed: LifecycleInput["answeredQuestions"] = [];

  for (const event of events) {
    if (event.origin === "tool_result" && event.callId) {
      answered.set(event.callId, event);
    }
  }

  for (const event of events) {
    const source = eventSource(state, sources, event);
    const message = object(object(source?.entry.original).message);
    const content = Array.isArray(message.content) ? message.content : [];

    for (const part of content) {
      const call = object(part);

      if (call.type !== "toolCall" || call.name !== "request_user_input") {
        continue;
      }

      const input = object(call.arguments);
      const pending = Array.isArray(input.questions) ? input.questions : [];
      const answer = answered.get(string(call.id));

      for (const question of pending) {
        const text = string(object(question).question);

        if (!answer) {
          questions.push({ eventId: event.id, question: text });
        } else if (answer.isError === false) {
          completed.push({ eventId: answer.id, questionEventId: event.id, question: text });
        }
      }
    }
  }

  return { pending: questions, answered: completed };
}

/** Retain successive current instructions and task-specific spans separately from the immutable original intent.
@param update - Exact request update, already scoped to its explicit task spans.
@returns Bounded request update with explicit source identity and truncation.
*/
function requestEvidence(update: TaskRequestUpdate) {
  return {
    eventId: update.eventId,
    text: update.text.slice(0, TASK_CLASSIFIERS.lifecycle.maxRequestLength),
    references: update.references,
    truncated: update.text.length > TASK_CLASSIFIERS.lifecycle.maxRequestLength,
  };
}

/** Build current lifecycle evidence without automatically revisiting frozen historical task state.
@param state - Exact expected checkpoint.
@param task - Authoritative task.
@param sources - Validated originals, loaded by the effectful runtime.
@param commands - Application-owned per-command execution facts.
@param isMainTurnActive - Runtime observation preventing premature completion during active work.
@returns Bounded current evidence or null when no current authorized request belongs to this task.
*/
export function lifecycleInput(
  state: Ledger,
  task: Task,
  sources: TaskSource[],
  commands: CommandEvidence[],
  isMainTurnActive: boolean
): LifecycleInput | null {
  const members = memberIds(state, task.id);

  let latestRequestId = "";
  let currentEvents: TaskEvent[] = [];

  const allEvents: TaskEvent[] = [];

  for (const event of state.events) {
    if (!members.has(event.id)) {
      continue;
    }

    allEvents.push(event);

    if (
      ["typed", "voice_request", "scheduled"].includes(event.origin) &&
      latestDecision(state, event.id)?.source !== "legacy"
    ) {
      latestRequestId = event.id;
      currentEvents = [];
    }

    currentEvents.push(event);
  }

  if (!latestRequestId || task.authority === "proposal") {
    return null;
  }

  const limit = TASK_CLASSIFIERS.lifecycle.maxEvents;
  const selected = currentEvents.slice(-limit);
  const requests = taskRequestUpdates(state, task.id);
  const selectedRequests = requests.slice(-TASK_CLASSIFIERS.lifecycle.maxRequests);
  const questions = unansweredQuestions(state, sources, allEvents);
  const outstanding = new Set(task.pendingQuestions);

  for (const answer of questions.answered) {
    if (task.evidence.includes(answer.questionEventId)) {
      outstanding.delete(answer.question);
    }
  }

  const pendingQuestions = [...outstanding].slice(0, TASK_CLASSIFIERS.lifecycle.maxPendingQuestions);

  return {
    task: {
      id: task.id,
      originalIntent: task.originalIntent.slice(0, TASK_CLASSIFIERS.lifecycle.maxIntentLength),
      intentTruncated: task.originalIntent.length > TASK_CLASSIFIERS.lifecycle.maxIntentLength,
      work: task.work,
      pendingQuestions,
    },
    latestRequestId,
    isMainTurnActive,
    requests: Array.from(selectedRequests, requestEvidence),
    omittedRequests: Math.max(0, requests.length - selectedRequests.length),
    events: Array.from(selected, eventEvidence.bind(undefined, state, sources)),
    pendingQuestions: questions.pending,
    answeredQuestions: questions.answered,
    omittedQuestions: Math.max(0, outstanding.size - pendingQuestions.length),
    commands,
    omittedEvents: Math.max(0, currentEvents.length - limit),
  };
}

/** Identify fresh source evidence independently of the lifecycle change produced by its own review.
@param input - Current evidence packet.
@returns Stable source fingerprint; unchanged evidence is not repeatedly sent to the provider.
*/
export function lifecycleInputHash(input: LifecycleInput) {
  const task = { ...input.task, work: "reviewed separately", pendingQuestions: [] };
  const evidence = {
    ...input,
    task,
    version: TASK_CLASSIFIERS.lifecycle.version,
    dependencyVersion: TASK_CLASSIFIERS.lifecycle.dependencyVersion,
  };

  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
