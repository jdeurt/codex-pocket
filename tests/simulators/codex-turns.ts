import { type Data, type Item, type Turn, object, string } from "../../src/lib/protocol";
import { type CodexStore } from "./codex-store";
import { array } from "./values";
import { randomUUID } from "node:crypto";
import { validateResult } from "./contract";

export interface TurnScenario {
  chunks?: string[];
  hold?: boolean;
  failure?: string;
  requests?: { method: string; params: Data; answer?: unknown }[];
  usage?: Data;
}

/**
Model explicit turn lifetimes and bidirectional requests without executing model-selected tools.
*/
export class CodexTurns {
  private pending = new Map<string, { threadId: string; turn: Turn; scenario: TurnScenario }>();
  private requests = new Map<string, { turnId: string; method: string }>();

  /**
Bind turns to a durable store and a schema-checked wire emitter.
@param store - Isolated state owner.
@param emit - Server message delivery callback.
@param scenario - Deterministic response behavior; no inference occurs.
*/
  constructor(
    private store: CodexStore,
    private emit: (message: Data) => void,
    private scenario: TurnScenario = {}
  ) {}

  /**
Emit a typed native lifecycle notification.
@param method - Native notification method.
@param params - Native payload.
*/
  private notify(method: string, params: Data) {
    this.emit({
      method,
      params: {
        ...structuredClone(params),
        ...(method === "item/started" && { startedAtMs: Date.now() }),
        ...(method === "item/completed" && { completedAtMs: Date.now() }),
      },
    });
  }

  /** Reject overlapping active turns before mutating history.
  @param turns - Existing thread history.
  */
  private assertIdle(turns: Turn[]) {
    if (turns.some((turn) => turn.status === "inProgress")) {
      throw new Error("turn already in progress");
    }
  }

  /**
Finish output with literal chunks, optional usage, and one terminal event.
@param threadId - Owning thread.
@param turn - Active turn.
@param scenario - Remaining deterministic output.
*/
  private complete(threadId: string, turn: Turn, scenario: TurnScenario) {
    const item: Item = { id: randomUUID(), type: "agentMessage", text: "" };
    const chunks = scenario.chunks ?? ["SIMULATED_REPLY"];

    this.notify("item/started", { threadId, turnId: turn.id, item });

    for (const delta of chunks) {
      item.text = string(item.text) + delta;
      this.notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: item.id, delta });
    }

    turn.items.push(item);
    this.notify("item/completed", { threadId, turnId: turn.id, item });

    if (scenario.usage) {
      this.notify("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: scenario.usage });
    }

    turn.status = scenario.failure ? "failed" : "completed";
    turn.error = scenario.failure ? { message: scenario.failure } : null;
    this.finish(threadId, turn);
  }

  /**
Commit terminal status before publishing completion.
@param threadId - Owner.
@param turn - Completed, failed or interrupted turn.
*/
  private finish(threadId: string, turn: Turn) {
    const thread = this.store.get(threadId);

    this.pending.delete(turn.id);
    thread.status = { type: "idle" };
    this.store.save();
    this.notify("thread/status/changed", { threadId, status: thread.status });
    this.notify("turn/completed", { threadId, turn });
  }

  /**
Issue a distinct server-request identity and bind it to the active turn.
@param turnId - Active turn.
@param threadId - Owning thread.
@param requests - Remaining scripted requests.
*/
  private request(turnId: string, threadId: string, requests: NonNullable<TurnScenario["requests"]>) {
    const request = requests.shift();
    const id = request ? randomUUID() : "";

    if (!request) {
      throw new Error("Missing scripted request");
    }

    this.requests.set(id, { turnId, method: request.method });
    this.emit({ id, method: request.method, params: { ...request.params, threadId, turnId } });
  }

  /**
Start one active turn and acknowledge it before streaming its output.
@param params - Native turn/start parameters.
@returns Native turn acknowledgement.
*/
  start(params: Data) {
    const thread = this.store.get(params.threadId);
    const turn: Turn = { id: randomUUID(), status: "inProgress", items: [], error: null };
    const user: Item = {
      id: randomUUID(),
      type: "userMessage",
      clientId: params.clientUserMessageId ?? null,
      content: params.input,
    };

    this.assertIdle(thread.turns);

    thread.turns.push(turn);
    thread.status = { type: "active", activeFlags: [] };
    this.notify("thread/status/changed", { threadId: thread.id, status: thread.status });
    this.notify("turn/started", { threadId: thread.id, turn });
    turn.items.push(user);
    this.notify("item/started", { threadId: thread.id, turnId: turn.id, item: user });
    this.notify("item/completed", { threadId: thread.id, turnId: turn.id, item: user });
    this.pending.set(turn.id, { threadId: thread.id, turn, scenario: structuredClone(this.scenario) });

    return { turn: structuredClone(turn) };
  }

  /**
Deliver pending scripted server requests before finishing the turn.
@param turnId - Acknowledged turn identity.
*/
  advance(turnId: string) {
    const entry = this.pending.get(turnId);

    if (!entry || entry.scenario.hold) {
      return;
    }

    if (entry.scenario.requests?.length) {
      this.request(turnId, entry.threadId, entry.scenario.requests);

      return;
    }

    this.complete(entry.threadId, entry.turn, entry.scenario);
  }

  /**
  Release a deliberately held scenario to test attachment and completion races.
  @param turnId - Existing simulated turn to finish without another native input.
  */
  release(turnId: string) {
    const entry = this.pending.get(turnId);

    if (!entry) {
      throw new Error("No held turn exists with this ID");
    }

    entry.scenario.hold = false;
    this.advance(turnId);
  }

  /**
Apply conditional steering or interrupt the existing active turn.
@param method - turn/steer or turn/interrupt.
@param params - Native conditional identity and input.
@returns Native operation receipt.
*/
  control(method: string, params: Data) {
    const thread = this.store.get(params.threadId);
    const turn = thread.turns.find((entry) => entry.status === "inProgress");
    const action = method === "turn/steer" ? "steer" : "interrupt";

    if (!turn) {
      throw new Error(`no active turn to ${action}`);
    }

    if (method === "turn/steer") {
      if (params.expectedTurnId !== turn.id) {
        throw new Error("expected turn does not match active turn");
      }

      turn.items.push({
        id: randomUUID(),
        type: "userMessage",
        clientId: params.clientUserMessageId ?? null,
        content: array(params.input),
      });

      return { turnId: turn.id };
    }

    if (params.turnId !== turn.id) {
      throw new Error("turn ID does not match active turn");
    }

    turn.status = "interrupted";
    this.finish(thread.id, turn);

    return {};
  }

  /**
Resume a turn after the host replies to a scripted server request.
@param response - Native client response.
*/
  respond(response: Data) {
    const request = this.requests.get(string(response.id));
    const entry = request ? this.pending.get(request.turnId) : undefined;

    if (!request || !entry) {
      throw new Error("Unknown or duplicate server response");
    }

    this.requests.delete(string(response.id));

    if (object(response.error).message) {
      entry.scenario.failure = string(object(response.error).message);
    } else {
      validateResult(request.method, response.result, "ServerRequest");
    }

    this.advance(request.turnId);
  }
}
