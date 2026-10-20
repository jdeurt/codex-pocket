import { CodexStore, pageOf, sessionResponse } from "./codex-store";
import { CodexTurns, type TurnScenario } from "./codex-turns";
import { type Data, object, string } from "../../src/lib/protocol";
import { type ScriptedCall, validateMessage, validateResult } from "./contract";
import { CodexFiles } from "./codex-files";
import { isDeepStrictEqual } from "node:util";
import { setTimeout } from "node:timers/promises";

const INVALID_REQUEST = -32_600;
const INVALID_PARAMS = -32_602;
const SIMULATOR_UNIMPLEMENTED = -32_001;

/**
Stateful app-server simulator with full-contract validation and explicit arbitrary-method scenarios.
*/
export class CodexSimulator {
  private initialized = false;
  private files = new CodexFiles();
  private scripts: ScriptedCall[];
  store: CodexStore;
  turns: CodexTurns;
  calls: Data[] = [];

  /**
Create a transport-independent instance with isolated state and deterministic output.
@param emit - Deliver native wire messages.
@param options - Persistence, scripted calls and model output.
*/
  constructor(
    private emit: (message: Data) => void,
    options: { stateFile?: string; scripts?: ScriptedCall[]; turn?: TurnScenario } = {}
  ) {
    this.store = new CodexStore(options.stateFile);
    this.scripts = structuredClone(options.scripts ?? []);
    this.turns = new CodexTurns(
      this.store,
      (message) => {
        this.event(message);
      },
      options.turn
    );
  }

  /**
Validate unsolicited messages in either native server direction.
@param message - Complete server request or notification.
*/
  private event(message: Data) {
    validateMessage(string(message.method), message, message.id === undefined ? "ServerNotification" : "ServerRequest");
    this.emit(message);
  }

  /**
Consume a caller-authored scenario without treating unimplemented behavior as success.
@param method - Native method.
@param params - Validated request parameters.
@returns Script, or undefined when the state model owns this request.
*/
  private scripted(method: string, params: unknown) {
    const script = this.scripts.at(0);

    if (script?.method !== method) {
      return;
    }

    if (script.params !== undefined && !isDeepStrictEqual(script.params, params)) {
      throw new Error(`Scenario parameter mismatch for ${method}`);
    }

    this.scripts.shift();

    return script;
  }

  /** Refuse pre-handshake operations.
  @param method - Native method.
  */
  private assertInitialized(method: string) {
    if (method !== "initialize" && !this.initialized) {
      throw new Error("Not initialized");
    }
  }

  /**
Model core thread operations and refuse all other methods unless explicitly scripted.
@param method - Native request method.
@param params - Validated request parameters.
@returns Native response.
*/
  private execute(method: string, params: Data): unknown {
    this.assertInitialized(method);

    if (method.startsWith("fs/")) {
      return this.files.execute(method, params);
    }

    switch (method) {
      case "initialize": {
        if (this.initialized) {
          throw new Error("Already initialized");
        }

        this.initialized = true;

        return { userAgent: "Pocket simulator", codexHome: "/simulator", platformFamily: "unix", platformOs: "linux" };
      }

      case "thread/start": {
        const thread = this.store.create(params);

        this.event({ method: "thread/started", params: { thread } });

        return sessionResponse(thread);
      }

      case "thread/loaded/list": {
        return pageOf([...this.store.loaded], params);
      }

      case "thread/list": {
        return pageOf(
          this.store.threads
            .values()
            .filter((thread) => this.store.archived.has(thread.id) === !!params.archived)
            .toArray(),
          params
        );
      }

      case "turn/start": {
        return this.turns.start(params);
      }

      case "turn/steer":
      case "turn/interrupt": {
        return this.turns.control(method, params);
      }

      default: {
        return this.threadOperation(method, params);
      }
    }
  }

  /**
Apply operations that require an existing thread.
@param method - Native method.
@param params - Validated parameters.
@returns Native operation response.
*/
  private threadOperation(method: string, params: Data): unknown {
    const thread = params.threadId ? this.store.get(params.threadId) : undefined;

    if (!thread) {
      throw new Error(`SIMULATOR_UNIMPLEMENTED: ${method}; supply an explicit scenario`);
    }

    switch (method) {
      case "thread/read": {
        if (thread.ephemeral && params.includeTurns) {
          throw new Error("ephemeral threads do not support includeTurns");
        }

        return { thread: { ...thread, turns: params.includeTurns ? thread.turns : [] }, readState: null };
      }

      case "thread/turns/list": {
        return pageOf(thread.turns, params);
      }

      case "thread/resume": {
        this.store.loaded.add(thread.id);
        thread.model = params.model ?? thread.model;
        thread.reasoningEffort = object(params.config).model_reasoning_effort ?? thread.reasoningEffort;

        return sessionResponse(thread);
      }

      case "thread/fork": {
        const fork = this.store.create({ ...thread, ...params });

        fork.turns = structuredClone(thread.turns);
        fork.forkedFromId = thread.id;

        return sessionResponse(fork);
      }

      case "thread/settings/update": {
        thread.model = params.model ?? thread.model;
        thread.reasoningEffort = params.effort ?? thread.reasoningEffort;

        return {};
      }

      case "thread/name/set": {
        thread.name = string(params.name);
        this.event({ method: "thread/name/updated", params: { threadId: thread.id, threadName: thread.name } });

        return {};
      }

      case "thread/archive": {
        this.store.archived.add(thread.id);
        this.store.loaded.delete(thread.id);
        this.event({ method: "thread/archived", params: { threadId: thread.id } });

        return {};
      }

      case "thread/unarchive": {
        this.store.archived.delete(thread.id);

        return { thread };
      }

      case "thread/unsubscribe": {
        this.store.loaded.delete(thread.id);

        return { status: "unsubscribed" };
      }

      case "thread/delete": {
        this.store.threads.delete(thread.id);
        this.store.archived.delete(thread.id);
        this.store.loaded.delete(thread.id);

        return {};
      }

      default: {
        throw new Error(`SIMULATOR_UNIMPLEMENTED: ${method}; supply an explicit scenario`);
      }
    }
  }

  /**
Run a matched script or state transition and validate every successful reply.
@param message - Original request envelope.
@param method - Native operation.
@param params - Validated parameters.
*/
  private async dispatch(message: Data, method: string, params: Data) {
    const script = this.scripted(method, message.params);
    const result = script ? script.result : this.execute(method, params);
    const before = script?.before ?? [];
    const after = script?.after ?? [];
    const turnId = string(object(object(result).turn).id);

    if (script?.delayMs) {
      await setTimeout(script.delayMs);
    }

    for (const event of before) {
      this.event(event);
    }

    if (script?.disconnect) {
      throw new Error("SIMULATOR_DISCONNECT");
    }

    if (script?.error) {
      this.emit({ id: message.id, error: script.error });
    } else {
      validateResult(method, result);
      this.store.save();
      this.emit({ id: message.id, result: structuredClone(result) });
    }

    for (const event of after) {
      this.event(event);
    }

    if (method === "turn/start") {
      this.turns.advance(turnId);
    }
  }

  /**
Accept real newline-delimited protocol records, preserving IDs, errors, and event ordering.
@param value - Decoded client request, notification or server-request response.
*/
  async receive(value: unknown) {
    const message = object(value);
    const method = string(message.method);
    const params = object(message.params);

    if (!method) {
      this.turns.respond(message);

      return;
    }

    this.calls.push(structuredClone(message));

    if (message.id === undefined) {
      validateMessage(method, message, "ClientNotification");

      return;
    }

    try {
      validateMessage(method, message);
    } catch (error) {
      this.emit({ id: message.id, error: { code: INVALID_PARAMS, message: String(error) } });

      return;
    }

    try {
      await this.dispatch(message, method, params);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      this.emit({
        id: message.id,
        error: {
          code: detail.startsWith("SIMULATOR_UNIMPLEMENTED") ? SIMULATOR_UNIMPLEMENTED : INVALID_REQUEST,
          message: detail,
        },
      });
    }
  }
}
