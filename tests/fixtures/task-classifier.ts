import assert from "node:assert/strict";
import { object, string, type Data } from "../../src/lib/protocol";
import { TASK_CLASSIFIERS } from "../../src/tasks/classifier-definitions";

export interface LifecycleScenario {
  outcome: "resolved" | "waiting" | "canceled" | "reopen" | "uncertain";
  requiresDelivery?: boolean;
  isAnswer?: boolean;
  isUserConfirmed?: boolean;
  asksQuestion?: boolean;
  areQuestionsAnswered?: boolean;
}

/** Supply a credential only to the explicitly mocked external classifier boundary.
@returns Synthetic task-provider credential.
*/
export function classifierCredential() {
  return Promise.resolve("synthetic-task-classifier-key");
}

/** Read a native fetch target without coercing a Request object into a diagnostic string.
@param target - Actual fetch target.
@returns Exact requested URL.
*/
function requestUrl(target: Parameters<typeof fetch>[0]) {
  if (typeof target === "string") {
    return target;
  }

  return target instanceof URL ? target.href : target.url;
}

/**
Own the external Decisions replay boundary independently of Pi's working-agent replay.
Positive completion claims are deliberately adversarial: deterministic guards must still reject unsupported work.
*/
export class TaskClassifierReplay {
  private readonly originalFetch = globalThis.fetch;
  readonly requests: { input: Data; questions: Data[] }[] = [];
  readonly continuations = new Map<string, { originalIntent: string; correction?: boolean; cancel?: boolean }>();
  readonly scenarios = new Map<string, LifecycleScenario>();
  readonly conversations = new Set<string>();
  gate?: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> };

  /** Interpret one explicit fixture continuation; no canned output is evidence of model quality.
  @param input - Actual current request and task descriptions supplied by production.
  @param name - Requested predicate identity.
  @returns Fixed scenario probability.
  */
  private intentProbability(input: Data, name: string) {
    if (this.conversations.has(string(input.current_request))) {
      return 0;
    }

    if (name === "actionable") {
      return 1;
    }

    const continuation = this.continuations.get(string(input.current_request));

    if (name === "independent") {
      return continuation ? 0 : 1;
    }

    if (name === "cancel") {
      return continuation?.cancel ? 1 : 0;
    }

    if (name === "correction") {
      return continuation?.correction ? 1 : 0;
    }

    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    const index = Number(name.slice("task_".length));

    return continuation && object(tasks[index]).originalIntent === continuation.originalIntent ? 1 : 0;
  }

  /** Supply an explicit lifecycle scenario while voting for every event as supporting evidence.
  @param input - Exact source packet from production.
  @param name - Requested predicate.
  @returns Scripted probability, including deliberately unsupported positive completion assessments.
  */
  private lifecycleProbability(input: Data, name: string) {
    if (name.startsWith("evidence_")) {
      return 1;
    }

    const task = object(input.task);
    const scenario = this.scenarios.get(string(task.originalIntent)) ?? { outcome: "resolved" };

    if (name.startsWith("pending_question_")) {
      return scenario.asksQuestion ? 1 : 0;
    }

    if (name.startsWith("answered_question_")) {
      return scenario.areQuestionsAnswered ? 1 : 0;
    }

    if (name === "delivery_required") {
      return scenario.requiresDelivery ? 1 : 0;
    }

    if (name === "answer_satisfies_request") {
      return scenario.isAnswer ? 1 : 0;
    }

    if (name === "user_confirmed") {
      return scenario.isUserConfirmed ? 1 : 0;
    }

    return name === scenario.outcome ? 1 : 0;
  }

  /** Intercept only the documented external classifier endpoint; preserve unrelated production I/O.
  @param target - Actual request URL.
  @param options - Actual outgoing provider contract.
  @returns Controlled provider response, with optional deferred completion for concurrency tests.
  */
  async fetch(target: Parameters<typeof fetch>[0], options?: RequestInit) {
    if (requestUrl(target) !== TASK_CLASSIFIERS.endpoint) {
      return this.originalFetch(target, options);
    }

    assert.ok(options);
    assert.equal(options.method, "POST");
    const body = object(JSON.parse(string(options.body)));
    const input = object(JSON.parse(string(body.input)));
    const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
    const questions = Array.from(rawQuestions, object);

    assert.equal(body.model, TASK_CLASSIFIERS.model);
    this.requests.push({ input, questions });

    if (input.task && this.gate) {
      this.gate.entered.resolve(undefined);
      await this.gate.release.promise;
    }

    const answers = [];

    for (const question of questions) {
      const name = string(question.name);
      const probability =
        input.current_request === undefined
          ? this.lifecycleProbability(input, name)
          : this.intentProbability(input, name);

      answers.push({ type: "predicate", name, probability });
    }

    return Response.json({ answers });
  }
}
