import { latestDecision } from "./reconciliation";
import { isTaskAuthoritative, type Ledger, type Task } from "./model";

const DESCRIPTION_LENGTH = 1200;
const TITLE_LENGTH = 160;
const QUESTION_LIMIT = 10;

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

/** Describe a task without copying accumulated transport messages into classifier context.
@param task - Authoritative task navigation value.
@returns Bounded stable intent and explicit updates.
*/
function taskDescription(task: Task) {
  return {
    id: task.id,
    revision: task.revision,
    title: task.title.slice(0, TITLE_LENGTH),
    originalIntent: task.originalIntent.slice(0, DESCRIPTION_LENGTH),
    summary: task.summary.slice(0, DESCRIPTION_LENGTH),
    work: task.work,
    retention: task.retention,
    pendingQuestions: Array.from(task.pendingQuestions.slice(0, QUESTION_LIMIT), boundedQuestion),
  };
}

/** Build bounded task descriptions from stable intent and explicit updates, including archived tasks.
@param state - Parent ledger.
@returns Classifier references without accumulated raw transport history.
*/
export function taskDescriptions(state: Ledger) {
  const tasks = state.tasks.filter(isTaskAuthoritative.bind(undefined, state.mode));

  return Array.from(tasks, taskDescription.bind(undefined));
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

  const navigation = JSON.stringify({
    revision: state.revision,
    compactionAllowed: false,
    diagnostic:
      "Protected work exceeds the context budget. Existing history was retained. " +
      "Use pocket_task_inspect pages or a taskId/eventId to read exact work before continuing.",
    tasks: Array.from(state.tasks.slice(0, NAVIGATION_LIMIT), contextTaskReference),
    commands: Array.from(state.commands.slice(0, NAVIGATION_LIMIT), contextCommandReference),
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

  for (const task of state.tasks) {
    if (state.mode === "live" && task.authority === "proposal") {
      continue;
    }

    if (task.work === "open" || task.work === "waiting" || task.pendingQuestions.length > 0) {
      required.push({
        id: task.id,
        authority: task.authority,
        retention: task.retention,
        evidence: task.evidence,
        work: task.work,
        originalIntent: task.originalIntent,
        summary: task.summary,
        pendingQuestions: task.pendingQuestions,
      });
    }
  }

  const unresolved = [];

  for (const event of state.events) {
    const decision = latestDecision(state, event.id);

    if (
      event.requestId &&
      decision?.assignment.kind !== "conversation" &&
      !state.memberships.some(isEventMember.bind(undefined, event.id))
    ) {
      unresolved.push({ id: event.id, text: event.text, references: event.references, contentRefs: event.contentRefs });
    }
  }

  const protectedContext = {
    policy:
      "Legacy open state is conservative uncertainty, not a new request to replay " +
      "historical work. Inspect original evidence and current authorization before acting.",
    tasks: required,
    unresolved,
    commands: state.commands,
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
