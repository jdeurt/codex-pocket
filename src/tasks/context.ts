import { latestDecision } from "./reconciliation";
import { isTaskAuthoritative, type Ledger, type Task } from "./model";
import { taskReviewToken } from "./review";
import { commandTaskIds } from "./routing";
import { TASK_CLASSIFIERS } from "./classifier-definitions";
import { taskRequestUpdates, type TaskRequestUpdate } from "./intent-context";

const DESCRIPTION_LENGTH = TASK_CLASSIFIERS.intent.descriptionLength;
const TITLE_LENGTH = TASK_CLASSIFIERS.intent.titleLength;
const QUESTION_LIMIT = TASK_CLASSIFIERS.intent.questionLimit;

/** Check whether one request has explicit membership.
@param eventId - Request identity.
@param member - Recorded membership.
@returns Whether the event is associated.
*/
function isEventMember(eventId: string, member: Ledger["memberships"][number]) {
  return member.eventId === eventId;
}

/** Bound a navigation question without changing the retained original or protected context.
@param question - Original pending question.
@returns Bounded classifier reference with an explicit omission marker.
*/
function boundedQuestion(question: string) {
  return question.length > DESCRIPTION_LENGTH
    ? `${question.slice(0, DESCRIPTION_LENGTH)} [truncated reference]`
    : question;
}

/** Bound an explicit user-intent update without treating it as replacement original intent.
@param update - Task-scoped current request.
@returns Bounded source-backed update for intent interpretation.
*/
function boundedTaskUpdate(update: TaskRequestUpdate) {
  return { eventId: update.eventId, text: update.text.slice(0, DESCRIPTION_LENGTH) };
}

/** Describe a task without copying accumulated transport messages into classifier context.
@param state - Explicit source checkpoint.
@param task - Authoritative task navigation value.
@returns Bounded stable intent and explicit updates.
*/
function taskDescription(state: Ledger, task: Task) {
  const updates = taskRequestUpdates(state, task.id, task.originalEventId);

  return {
    id: task.id,
    revision: task.revision,
    title: task.title.slice(0, TITLE_LENGTH),
    originalIntent: task.originalIntent.slice(0, DESCRIPTION_LENGTH),
    summary: task.summary.slice(0, DESCRIPTION_LENGTH),
    work: task.work,
    retention: task.retention,
    pendingQuestions: Array.from(task.pendingQuestions.slice(0, QUESTION_LIMIT), boundedQuestion),
    updates: Array.from(updates.slice(-TASK_CLASSIFIERS.intent.updateLimit), boundedTaskUpdate),
  };
}

/** Build bounded task descriptions from stable intent and explicit updates, including archived tasks.
@param state - Parent ledger.
@returns Classifier references without accumulated raw transport history.
*/
export function taskDescriptions(state: Ledger) {
  const tasks = state.tasks.filter(isTaskAuthoritative.bind(undefined, state.mode));

  return Array.from(tasks, taskDescription.bind(undefined, state));
}

/** Derive user delivery from explicit recorded evidence, independently of model turn status.
@param state - Parent ledger.
@param task - Selected task.
@returns Actual delivery evidence and supporting event identities.
*/
export function taskDelivery(state: Ledger, task: Task) {
  const evidence: string[] = [];

  let delivery: Ledger["events"][number]["delivery"] = task.authority === "legacy" ? "uncertain" : "not_delivered";

  for (const member of state.memberships) {
    if (member.taskId !== task.id) {
      continue;
    }

    for (const event of state.events) {
      if (event.id !== member.eventId || event.delivery === "not_delivered") {
        continue;
      }

      evidence.push(event.id);
      delivery = event.delivery === "delivered" ? "delivered" : delivery;
      delivery = delivery !== "delivered" && event.delivery === "uncertain" ? "uncertain" : delivery;
    }
  }

  return { state: delivery, evidence };
}

const NAVIGATION_LIMIT = 5;

/** Select foreground tasks independently of their completion state.
@param mode - Explicit ledger mode.
@param task - Stored task.
@returns Whether this task belongs in active model context.
*/
function isActiveContextTask(mode: Ledger["mode"], task: Task) {
  return isTaskAuthoritative(mode, task) && task.retention === "active";
}

/** Preserve outstanding archived questions and identities without copying the archived request into active context.
@param task - Explicitly archived task.
@returns Compact pending-work checkpoint, retrievable by exact identity.
*/
function deferredTaskContext(task: Task) {
  return {
    id: task.id,
    title: task.title.slice(0, TITLE_LENGTH),
    work: task.work,
    originalEventId: task.originalEventId,
    pendingQuestions: task.pendingQuestions,
  };
}

/** Select commands still relevant to foreground work or whose origin remains unresolved.
@param state - Parent checkpoint.
@param command - Per-command assignment.
@returns Whether command identity must remain in active model context.
*/
function isActiveContextCommand(state: Ledger, command: Ledger["commands"][number]) {
  const ids = commandTaskIds(state, command);

  if (ids.length === 0) {
    return true;
  }

  for (const task of state.tasks) {
    if (ids.includes(task.id) && task.retention === "active") {
      return true;
    }
  }

  return false;
}

/** Preserve task identities and provenance in a small model-navigation packet.
@param task - Retained task value.
@returns Bounded task navigation without replaying historical instructions.
*/
function contextTaskReference(task: Task) {
  return {
    id: task.id,
    title: task.title.slice(0, TITLE_LENGTH),
    authority: task.authority,
    retention: task.retention,
    work: task.work,
    originalEventId: task.originalEventId,
  };
}

/** Preserve delegate identities when full protected context must remain outside the prompt.
@param command - Recorded delegate assignment.
@returns Exact assignment and delegate identities.
*/
function contextCommandReference(command: Ledger["commands"][number]) {
  return { id: command.id, childId: command.childId, requestId: command.requestId };
}

/** Select a bounded model packet while retaining the full protected checkpoint for compaction policy.
@param state - Parent checkpoint.
@param text - Complete protected context.
@param budget - Explicit model-navigation budget.
@returns Full context when it fits, otherwise navigation to exact inspection records.
*/
function modelContextText(state: Ledger, text: string, budget: number) {
  if (text.length <= budget) {
    return text;
  }

  const activeTasks = state.tasks.filter(isActiveContextTask.bind(undefined, state.mode));
  const activeCommands = state.commands.filter(isActiveContextCommand.bind(undefined, state));
  const navigation = JSON.stringify({
    revision: state.revision,
    reviewToken: taskReviewToken(state),
    compactionAllowed: false,
    diagnostic:
      "Protected work exceeds the context budget. Existing history was retained. " +
      "Use pocket_task_inspect pages or a taskId/eventId to read exact work before continuing.",
    tasks: Array.from(activeTasks.slice(0, NAVIGATION_LIMIT), contextTaskReference),
    commands: Array.from(activeCommands.slice(0, NAVIGATION_LIMIT), contextCommandReference),
    totals: { tasks: state.tasks.length, commands: state.commands.length },
  });

  return navigation.length <= budget ? navigation : "";
}

/** Select pending context independently of task grouping and completion.
@param state - Current ledger.
@param budget - Explicit available character budget for navigation context.
@returns Task references, constraints, unresolved events and command identities to preserve during compaction.
*/
export function planTaskContext(state: Ledger, budget: number) {
  const required = [];
  const deferred = [];

  for (const task of state.tasks) {
    if (state.mode === "live" && task.authority === "proposal") {
      continue;
    }

    if (task.retention === "active") {
      required.push({
        id: task.id,
        authority: task.authority,
        retention: task.retention,
        evidence: task.evidence,
        work: task.work,
        originalIntent: task.originalIntent,
        summary: task.summary,
        pendingQuestions: task.pendingQuestions,
        requestUpdates: taskRequestUpdates(state, task.id, task.originalEventId),
      });
    } else if (task.work === "open" || task.work === "waiting" || task.pendingQuestions.length > 0) {
      deferred.push(deferredTaskContext(task));
    }
  }

  const unresolved = [];

  for (const event of state.events) {
    const decision = latestDecision(state, event.id);

    if (
      ["typed", "voice_request", "scheduled"].includes(event.origin) &&
      event.requestId &&
      decision?.assignment.kind !== "conversation" &&
      !state.memberships.some(isEventMember.bind(undefined, event.id))
    ) {
      unresolved.push({ id: event.id, text: event.text, references: event.references, contentRefs: event.contentRefs });
    }
  }

  const protectedContext = {
    revision: state.revision,
    reviewToken: taskReviewToken(state),
    policy:
      "Legacy open state is conservative uncertainty, not a new request to replay " +
      "historical work. Archived work is deferred; inspect its exact task before resuming authorized work. " +
      "The task subsystem assesses lifecycle independently; ledger state is context, not new authorization.",
    tasks: required,
    deferred,
    unresolved,
    commands: state.commands.filter(isActiveContextCommand.bind(undefined, state)),
  };
  const text = JSON.stringify(protectedContext);

  return {
    protectedContext,
    text,
    modelText: modelContextText(state, text, budget),
    canCompact: text.length <= budget,
    diagnostic: text.length > budget ? "Pending work exceeds the context budget; retain source context." : null,
  };
}
