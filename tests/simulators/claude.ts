import { type Data, object, string } from "../../src/lib/protocol";
import { claudeAssistant, claudeInit, claudeResult } from "./claude-messages";
import { type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ScriptedCall } from "./contract";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { t as attempt } from "try";

const permissionMode = z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);

export interface ClaudeScenario {
  text?: string;
  hold?: boolean;
  failure?: string;
  requests?: Data[];
  messages?: Data[];
  controls?: ScriptedCall[];
}

/**
Simulate the Claude Code streaming control protocol behind the unmodified real Agent SDK.
*/
export class ClaudeSimulator {
  private initialized = false;
  private active?: Data;
  private queue: Data[] = [];
  private pending?: string;
  private requests: Data[] = [];
  private settings: Data = {};
  private servers: Data = {};
  sessionId: string;
  model: string;
  permission: SDKSystemMessage["permissionMode"];

  /**
Bind an isolated protocol session to deterministic scenarios.
@param emit - Native stdout sink.
@param options - Explicit scenario and native launch flags.
*/
  constructor(
    private emit: (record: Data) => void,
    private options: ClaudeScenario & { sessionId?: string; model?: string; permissionMode?: string } = {}
  ) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.model = options.model ?? "simulator-model";
    this.permission = permissionMode.parse(options.permissionMode ?? "default");
  }

  /**
Return a control initialization catalog without credentials, plugins or external servers.
@returns Native initialization response.
*/
  private initialization() {
    return {
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [{ value: this.model, displayName: this.model, description: "Deterministic test model" }],
      account: {},
    };
  }

  /**
Implement session controls and fail clearly for unscripted external integrations.
@param request - SDK control request payload.
@returns Native control result.
*/
  private control(request: Data): unknown {
    switch (request.subtype) {
      case "initialize": {
        this.initialized = true;

        return this.initialization();
      }

      case "set_model": {
        this.model = string(request.model) || "simulator-model";

        return undefined;
      }

      case "set_permission_mode": {
        this.permission = permissionMode.parse(request.mode);

        return { mode: this.permission };
      }

      case "interrupt": {
        const queued = this.queue.map((message) => message.uuid);

        if (this.active) {
          this.finish("interrupted");
        }

        return { still_queued: queued };
      }

      case "mcp_status": {
        return {
          mcpServers: Object.entries(this.servers).map(([name, config]) => ({ name, status: "connected", config })),
        };
      }

      case "mcp_set_servers": {
        const next = object(request.servers);
        const added = Object.keys(next).filter((name) => !Object.hasOwn(this.servers, name));
        const removed = Object.keys(this.servers).filter((name) => !Object.hasOwn(next, name));

        this.servers = next;

        return { added, removed, errors: {} };
      }

      case "apply_flag_settings": {
        Object.assign(this.settings, object(request.settings));

        return {};
      }

      case "get_settings": {
        return { settings: this.settings };
      }

      case "set_max_thinking_tokens": {
        this.settings.maxThinkingTokens = request.max_thinking_tokens;

        return {};
      }

      case "list_models": {
        return { models: this.initialization().models };
      }

      case "reload_skills": {
        return { commands: [] };
      }

      case "reload_output_styles": {
        return { available_output_styles: ["default"], output_style: "default" };
      }

      default: {
        throw new Error(`SIMULATOR_UNIMPLEMENTED: ${String(request.subtype)}; supply an explicit control scenario`);
      }
    }
  }

  /** Execute a control request before wrapping execution errors.
  @param message - Native control request.
  */
  private replyControl(message: Data) {
    const request = object(message.request);
    const script = this.options.controls?.find((entry) => entry.method === request.subtype);

    if (!this.initialized && request.subtype !== "initialize") {
      throw new Error("Not initialized");
    }

    if (script?.error) {
      throw new Error(script.error.message);
    }

    this.emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: script ? script.result : this.control(request),
      },
    });
  }

  /**
Reply to SDK controls while retaining their request identity and native error envelope.
@param message - Complete native control request.
*/
  private controlRequest(message: Data) {
    const outcome = attempt(() => {
      this.replyControl(message);
    });

    if (outcome.ok) {
      return;
    }

    const error = outcome.error;

    this.emit({
      type: "control_response",
      response: { subtype: "error", request_id: message.request_id, error: String(error) },
    });
  }

  /**
Begin one turn or enqueue subsequent input behind an active turn.
@param message - SDK user message with its durable UUID.
*/
  private user(message: Data) {
    this.queue.push(message);
    this.nextTurn();
  }

  /**
  Start queued input only when the prior terminal receipt has been delivered.
  */
  private nextTurn() {
    if (this.active || this.queue.length === 0) {
      return;
    }

    this.startTurn(object(this.queue.shift()));
  }

  /** Start one queued message with an independent request list.
  @param message - Queued SDK input.
  */
  private startTurn(message: Data) {
    this.active = message;
    this.requests = structuredClone(this.options.requests ?? []);
    this.emit(claudeInit(this.sessionId, this.model, this.permission));
    this.advance();
  }

  /**
Deliver requests one at a time, waiting for the SDK's permission, hook, or dialog reply.
*/
  private advance() {
    const request = this.requests.shift();

    if (request) {
      this.pending = randomUUID();
      this.emit({ type: "control_request", request_id: this.pending, request });

      return;
    }

    if (!this.options.hold) {
      this.finish(this.options.failure);
    }
  }

  /**
Publish a terminal result and continue queued input without losing receipt identities.
@param failure - Optional deterministic failure or interruption.
*/
  private finish(failure?: string) {
    const text = this.options.text ?? "SIMULATED_REPLY";
    const result = claudeResult(this.sessionId, text);
    const userId = this.active?.uuid;
    const messages = this.options.messages ?? [];

    for (const message of messages) {
      this.emit({ ...message, session_id: this.sessionId });
    }

    if (!failure) {
      this.emit({ ...claudeAssistant(this.sessionId, this.model, text), user_message_uuid: userId });
    }

    this.emit(
      failure
        ? { ...result, subtype: "error_during_execution", is_error: true, errors: [failure], result: undefined }
        : { ...result, user_message_uuid: userId }
    );
    this.active = undefined;
    this.pending = undefined;

    globalThis.queueMicrotask(() => {
      this.nextTurn();
    });
  }

  /** Resolve an outstanding server request exactly once.
  @param message - Host response.
  */
  private serverResponse(message: Data) {
    const response = object(message.response);

    if (!this.pending || response.request_id !== this.pending) {
      throw new Error("Unknown or duplicate Claude server response");
    }

    this.pending = undefined;

    if (response.subtype === "error") {
      this.finish(string(response.error));
    } else {
      this.advance();
    }
  }

  /**
Consume the native stream-json protocol without loading any CLI or performing external side effects.
@param value - JSON input line.
*/
  receive(value: unknown) {
    const message = object(value);

    switch (message.type) {
      case "control_request": {
        this.controlRequest(message);
        break;
      }

      case "user": {
        this.user(message);
        break;
      }

      case "control_response": {
        this.serverResponse(message);
        break;
      }

      case "keep_alive":
      case "control_cancel_request": {
        break;
      }

      default: {
        throw new Error(`Unexpected Claude wire record: ${String(message.type)}`);
      }
    }
  }
}
